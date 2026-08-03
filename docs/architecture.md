# Life Assistant 架构

Life Assistant 是 Hermes Agent 的 Skill + MCP 服务。查询通过 MCP 完成；所有模块的主动通知统一经过 Hermes Webhook，并由 Hermes Gateway 选择一个已连接平台投递。

## 1. 设计原则

- 模块只负责产生事件，不直接绑定 QQ、微信、Bark 或 Server酱。
- 通知先持久化，再尝试主动投递；`notify.pull` 只是失败恢复队列。
- Profile 私有数据和通知严格隔离；公共事件也按配置的 Profile 独立复制和去重。
- 保持轻量：显式超时、有限退避、幂等请求和最终 pull fallback，不追求无限重试或 exactly-once 网络语义。
- 天气简报由确定性天气/油价 Provider 数据生成，不依赖 LLM 的 model/provider 配置。

## 2. 总体架构

```text
模块 job / 标准 notify 回调 / 私有日程
                    |
                    v
       Profile notification + SQLite outbox
                    |
                    v
       HMAC V2 Hermes deliver-only Webhook
                    |
                    v
       一个配置的 Hermes Gateway 平台
       (qqbot / weixin / feishu / ...)

Webhook 失败或 route 缺失
                    |
                    v
          当前 Profile 的 notify.pull
```

`src/index.ts` 是 Hermes 拉起的 stdio MCP Server。`src/scheduler.ts` 是唯一常驻调度进程，执行模块 cron、私有日程扫描和 outbox 投递。二者共享 `DATA_DIR/life-assistant.sqlite`；同一 `DATA_DIR` 只应运行一个 scheduler，SQLite 中的租约会阻止正常情况下的重复调度。

## 3. 模块扩展契约

```ts
interface JobContext {
  notify(title: string, body: string, dedupeKey?: string): Promise<void>;
}

interface JobDef {
  name: string;
  cron: string;
  timezone?: string;
  handler(ctx: JobContext): Promise<void>;
}
```

模块在 `src/modules/<feature>/index.ts` 注册 `AssistantModule`，并在 `src/modules/index.ts` 导入。未来模块使用标准 `ctx.notify` 后，会自动进入公共事件发布逻辑，无需了解 route、HMAC 或 Gateway 平台。

天气预警和油价预通知使用该标准回调。天气模块另有 `weather.daily_brief` job，因为它需要明确的 `weather` source，但最终仍调用同一公共发布和 outbox 路径。

## 4. 通知作用域

### 公共模块事件

`publishGlobal` 枚举 `PROFILE_PUSH_ROUTES_JSON` 中的 Profile，为每个 Profile 写一条 `profile_notifications` 记录及其 outbox delivery。相同 `dedupe_key` 在每个 Profile 内唯一，因此重复执行不会增加投递。

配置多个 Profile route 时，同一公共天气或油价事件会产生一份独立投递给每个 Profile。这是为了保持每个 Profile 都能独立接收、pull 和标记已读的既有产品语义，不是重复发送缺陷。没有配置 route 的 Profile 不属于公共主动 fan-out 集合。

### 私有事件

日程提醒直接调用 `publishProfile(profileId, ...)`，只写所属 Profile。若该 Profile 没有 route，通知仍保留并可由该 Profile 的 `notify.pull` 读取，不会跨 Profile 暴露。

### 旧数据兼容

旧版本的 `global_notifications` 和 `global_notification_reads` 表继续保留并可由 `notify.pull` 消费，以兼容已有 SQLite 数据和 `store.json` 迁移结果。新公共事件不再写该旧路径。

## 5. Outbox 投递语义

Profile 通知和 delivery 在同一 SQLite 事务中创建。投递器提供：

- HMAC SHA-256 V2，签名内容为 `timestamp.body`；secret 只来自环境变量。
- `X-Request-ID` 作为 Hermes 幂等键；网络结果不确定时重用同一 ID，明确 HTTP 失败时提升 request generation。
- 每次请求 10 秒超时，HTTP 失败按 1m、5m、15m、1h 退避，最多尝试五次。
- 原子 claim token、过期 claim 接管和完成时 claim fencing，避免并发 worker 重复完成。
- route 名变化或 route 缺失时将旧 delivery 转为 fallback；已 sent/read 的通知不会因 route 漂移重新入队。
- 三次网络结果不确定或请求接近 Hermes 幂等窗口时停止主动重试，转入 fallback。

Webhook 成功时，delivery 标记为 `sent`，并在同一事务中写入 `profile_notification_reads`，所以 `notify.pull` 不会重复返回。用户先通过 `notify.pull` 看到通知时，尚未发送的 delivery 会被取消。

`NOTIFY_WEBHOOK_URL`、`BARK_URL`、`SERVERCHAN_SENDKEY` 和 stdout fan-out 已退出主动模块投递路径。项目不会把同一事件同时直发第三方通道。

## 6. 确定性天气简报

`weather.daily_brief` 默认使用 `0 7 * * *`，并在 `LIFE_ASSISTANT_TIMEZONE` 指定的 IANA 时区运行；未配置时使用进程本地时区。`DAILY_WEATHER_BRIEF_CRON` 可覆盖表达式。

Job 并发读取当前天气、当天预报和可选油价：

- 实时天气或预报单项失败时，用另一个天气结果继续生成。
- 两个天气源都失败时，本次 job 失败，不发送空的“天气”简报。
- 油价失败、未配置或返回不可用占位值时直接省略。
- 正文是简短中文行，不使用 Markdown 表格。
- `weather:daily-brief:<本地日期>` 作为 dedupe key，每个配置 Profile 每个本地日期至多一条。

简报生成阶段不调用 OpenAI 或其他 LLM。现有外部 Hermes 07:00 LLM cron 不由本仓库管理，本次实现不会修改或删除它。部署并验证新 scheduler 后，运维者必须取得用户明确确认，才可停用或删除旧 cron；只更换旧 cron 的 `--deliver` 不能解决 model/provider 漂移。确认前同时运行可能造成重复通知，旧 cron 的原有失败也仍会出现。

## 7. 平台切换

主动目标属于 Hermes 动态 Webhook 订阅，不属于 Life Assistant 数据模型。若 route 名、URL 和 HMAC secret 保持不变，只需用相同订阅配置重建 Hermes subscription，并把 `--deliver` 改成目标平台：

```text
life-assistant module -> Profile outbox -> stable webhook route -> --deliver <platform>
```

这种切换不需要迁移 SQLite、不需要修改 Life Assistant 配置，通常也不需要重启 scheduler 或 Gateway，因为 Hermes 动态订阅会热加载。只有修改平台凭据/静态平台配置时才可能需要重启对应 Gateway；修改 route 名、URL 或 secret 时才需要同步 `PROFILE_PUSH_ROUTES_JSON` 并重启 scheduler。

secret 不得打印、检查真实值、粘贴到聊天或提交 Git。当前模型是每个 Profile 一个 Hermes route 和一个 Gateway 投递目标，不支持同时向多个第三方平台 fan-out。

## 8. 存储与迁移

SQLite 启用 WAL、foreign keys、busy timeout 和事务。Profile notification 使用 `(profile_id, dedupe_key)` 唯一约束；delivery 外键绑定 `(profile_id, notification_id)`，防止跨 Profile 引用。迁移是 additive 的，并保留旧 JSON 通知与读取标记的导入逻辑。

位置、天气 geo cache 等共享数据继续通过 SQLite `kv` facade 访问。Profile 私有日程、occurrence、notification、read 和 delivery 均带 `profile_id`。MCP 进程必须显式提供合法 `HERMES_PROFILE`，不能静默回退到 `default`。

## 9. 数据源

| 能力 | 首选 | 降级 |
|---|---|---|
| 实时天气/预报 | QWeather（配置 Key 时） | Open-Meteo |
| 天气预警 | QWeather 官方预警 | Open-Meteo 阈值推断 |
| 当前油价 | TianAPI | JUHE；均未配置时返回不可用占位值 |
| 调价窗口 | 本地年度窗口表 | 无 |

外部调用收敛在各模块 `provider.ts`。快递模块当前封存，未注册到运行时。
