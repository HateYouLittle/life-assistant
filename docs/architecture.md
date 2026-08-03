# Life Assistant 架构

Life Assistant 是 Hermes Agent 的 Skill + MCP 服务。查询面由 Hermes Profile 启动的 stdio MCP 进程提供；主动通知面由一个独立 scheduler 执行。模块只产生事件，不直接绑定消息平台。

## 1. 进程边界

```text
查询面
Hermes Profile -> src/index.ts -> MCP tools -> SQLite / Provider

主动通知面
src/scheduler.ts -> module cron + schedule scan + outbox delivery
                         |
                         v
              Profile notification + delivery
                         |
                         v
             Hermes HMAC V2 deliver-only route
                         |
                         v
             一个 Profile 的一个 Gateway 平台

失败或 route 缺失 -> notify.pull
```

`src/index.ts` 不启动 cron。default 或其他 Profile 分别启动 MCP 进程，并显式注入各自的 `HERMES_PROFILE`；这些进程与 scheduler 共享同一个 `DATA_DIR/life-assistant.sqlite`。

`src/scheduler.ts` 是唯一常驻调度器，负责：

- 执行模块定义的 cron job；
- 每分钟扫描 Profile 私有日程；
- 投递到期的 Profile outbox delivery。

同一 `DATA_DIR` 只运行一个 scheduler。SQLite scheduler lease 能阻止正常情况下的重复启动和接管失控，但不把多实例调度变成支持的部署方式。生产运行应由 systemd 等进程管理器负责重启。

## 2. 数据所有权

| 数据/事件 | 作用域 | 行为 |
|---|---|---|
| 位置、天气 geo cache、油价数据 | 共享 | 所有 MCP Profile 和 scheduler 读取同一份数据 |
| 天气预警、油价预通知、每日生活简报 | 公共事件 | 为每个已配置 route 的 Profile 独立 materialize、去重和投递 |
| 日程、occurrence、日程通知 | Profile 私有 | 所有读写均带 `profile_id`，不会跨 Profile 查询或投递 |
| notification read、outbox delivery | Profile 私有 | 每个 Profile 独立确认、取消和 fallback |

MCP 日程工具不接受调用者提供的 `profileId`。进程边界中的 `HERMES_PROFILE` 必须满足格式要求，缺失或非法时服务拒绝启动，不能静默回退到 `default`。

公共模块调用 `publishGlobal` 后，系统枚举 `PROFILE_PUSH_ROUTES_JSON`，为每个配置 Profile 写入独立的 `profile_notifications` 和 delivery。同一个 `dedupe_key` 只在 Profile 内唯一，因此公共事件的 fan-out 是有意的多份隔离记录，不是跨 Profile 共享通知行。

私有日程调用 `publishProfile(profileId, ...)`。即使所属 Profile 没有 route，通知仍保存在该 Profile 下供 `notify.pull` 恢复，不会进入其他 Profile。

旧版本的 `global_notifications` 和 `global_notification_reads` 表继续保留，`notify.pull` 仍可消费它们，以兼容已有 SQLite 和旧 `store.json` 导入数据。新公共事件不再写旧表。

## 3. 模块与 job 契约

模块在 `src/modules/<feature>/index.ts` 注册 `AssistantModule`，并由 `src/modules/index.ts` 导入。标准 job 契约为：

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

模块 job 使用 `ctx.notify` 后进入公共事件发布路径，无需知道 Profile route、HMAC 或 Gateway 平台。私有通知必须由明确的 Profile 所有者路径发布。每个 job 都应使用正确 timezone、稳定 dedupe key，并让单轮 Provider 失败不破坏后续调度。

定时需求分为三个层级：

1. `schedule` reminder：静态或重复个人提醒，存储于 SQLite，严格属于创建它的 Profile。
2. code-defined module job：需要运行时天气、油价或其他实时数据的固定任务，由 scheduler 执行并通过标准通知接口发布。
3. planned automation：通用自然语言动态信息推送。当前尚未实现；规划设计为 SQLite 配置、白名单 action、scheduler 无 LLM 执行。

## 4. Outbox 与投递语义

Profile notification 与对应 delivery 在同一个 SQLite 事务中创建。SQLite 启用 WAL、foreign keys、busy timeout；delivery 外键绑定 `(profile_id, notification_id)`，避免跨 Profile 引用。claim token、过期 claim 接管和完成时 fencing 用于降低并发 worker 重复完成的风险。

每个 route 包含 route 名、loopback URL 和 64 位随机十六进制 secret。请求使用：

- JSON event type `life_assistant.reminder`；
- `X-Webhook-Timestamp`；
- HMAC SHA-256 V2 `X-Webhook-Signature-V2`，签名内容为 `timestamp.body`；
- `X-Request-ID`，格式包含 Profile、notification、route 和 request generation；
- 10 秒请求超时，禁止自动跟随重定向。

重试是有限的：

- 明确 HTTP 非 2xx 失败最多尝试 5 次，每次生成新的 request generation；
- 网络超时、断连等结果不确定失败最多尝试 3 次，复用相同 `X-Request-ID`；
- 退避间隔为 1 分钟、5 分钟、15 分钟、1 小时，后续间隔封顶 1 小时；
- 不确定请求接近 Hermes 幂等窗口，或达到对应次数上限后，delivery 转为 `fallback`。

这套机制提供持久化、去重键和有界重试，但网络与目标平台不具备 exactly-once 保证。`X-Request-ID` 用于降低不确定结果下的重复风险，不能被描述为绝对不重复。

Webhook 成功后，delivery 标记为 `sent`，并在同一事务中写入 `profile_notification_reads`，因此后续 `notify.pull` 不会重复返回。若用户先通过 `notify.pull` 读取通知，系统写入 read 并取消仍处于 `pending`、`failed` 或 `fallback` 的未发送 delivery，避免稍后重复推送。

route 缺失或变化时，旧的未完成 delivery 会转为 `fallback`；已 sent/read 的通知不会因 route 漂移重新入队。旧直连通知环境变量和 stdout fan-out 均不在当前投递路径中。

## 5. 确定性每日生活简报

`weather.daily_brief` 的 cron 来自 `DAILY_WEATHER_BRIEF_CRON`，默认 `0 7 * * *`；IANA 时区来自 `LIFE_ASSISTANT_TIMEZONE`，未配置时使用进程本地时区。

job 并发读取当前天气、当日预报和可选油价：

- 当前天气或预报单项失败时，使用另一个天气结果继续生成；
- 两个天气结果都不可用时，本轮失败，不发送空简报；
- 油价未配置、失败或为不可用占位值时省略油价；
- 使用 `weather:daily-brief:<本地日期>` 作为 dedupe key；
- 内容由 Provider 数据确定性拼装，不调用 OpenAI 或其他 LLM。

迁移旧部署时，外部 Hermes 07:00 LLM cron 可能与内置简报并存。应先端到端验证新简报，再暂停或删除旧 cron；它不属于本仓库管理范围，不能把一次部署动作写成系统持续状态。

## 6. Hermes route 与平台切换

每个配置 Profile 对应一条 Hermes `deliver-only` route：

```text
Profile outbox -> stable loopback webhook route -> --deliver <platform>
```

订阅 prompt 为 `{notification.title}\n\n{notification.body}`，并使用与 `PROFILE_PUSH_ROUTES_JSON` 相同的 HMAC secret。当前模型中，一个 Profile route 只选择一个 Gateway 目标平台，不从 Life Assistant 同时直发 QQ、微信、Bark 或 Server酱。

平台选择属于 Hermes 动态订阅，不属于 Life Assistant 数据模型。route 名、URL 和 secret 不变时，重建同名 subscription 并只修改 `--deliver` 即可，通常无需迁移 SQLite、修改 scheduler 配置或重启 Gateway。平台凭据/静态配置变化时可能需要重启对应 Gateway；route 名、URL 或 secret 变化时必须同步更新 `PROFILE_PUSH_ROUTES_JSON` 并重启 scheduler。

secret 只来自环境变量或权限受限的配置文件，不得打印到日志、粘贴到聊天或提交 Git。

## 7. 数据源

| 能力 | 首选 | 兜底 |
|---|---|---|
| 实时天气/预报 | QWeather（配置 Key 时） | Open-Meteo |
| 天气预警 | QWeather 官方预警 | Open-Meteo 阈值推断 |
| 当前油价 | TianAPI | JUHE；均不可用时返回说明 |
| 调价窗口 | 本地年度窗口表 | 无 |

外部 HTTP 逻辑收敛在模块 `provider.ts` 和 `core/http.ts`。快递模块已封存且未注册到运行时。

## 8. 演进原则

迁移保持 additive，并保留旧数据读取兼容。新增模块不得直绑消息平台；新增私有数据必须带 Profile 所有权；新增公共 job 必须接受按配置 Profile 独立 materialize 的语义。动态 automation 是未来扩展层，不得在实现前写成当前功能。
