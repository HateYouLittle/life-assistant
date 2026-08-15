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
| 中国大陆节假日/工作日历法 | 共享 | scheduler 自动抓取并按数据集日期范围入库；MCP 工具只读（缺数据时按规则补齐） |
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

`AssistantModule` 还支持可选 `onStart(): Promise<void>`：scheduler 取得租约后为每个模块调用一次（不阻塞启动，异常只记日志），用于启动引导类数据补齐（当前 holiday 模块用它确保当年节假日数据可用）。

模块 job 使用 `ctx.notify` 后进入公共事件发布路径，无需知道 Profile route、HMAC 或 Gateway 平台。私有通知必须由明确的 Profile 所有者路径发布。每个 job 都应使用正确 timezone、稳定 dedupe key，并让单轮 Provider 失败不破坏后续调度。

定时需求分为三个层级：

1. `schedule` reminder：静态或重复个人提醒，存储于 SQLite，严格属于创建它的 Profile。recurrence 除 RRule 频率外还支持 `workday`（中国大陆法定工作日）与 `holiday`（仅法定节假日休假日），两者基于共享节假日数据计算，见「中国大陆节假日历法」。
2. code-defined module job：需要运行时天气、油价或其他实时数据的固定任务，由 scheduler 执行并通过标准通知接口发布。
3. planned automation：通用自然语言动态信息推送。当前尚未实现；规划设计为 SQLite 配置、白名单 action、scheduler 无 LLM 执行。

循环日程在提醒窗口内创建或更新时，只要目标时刻（occurrence 或 deadline）仍在未来，错过窗口的触发时刻会立即在下一次扫描补发（与一次性日程的补发语义一致）。

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

route 缺失或变化时，旧的未完成 delivery 会转为 `fallback`；同名 route 恢复后，因 route 配置漂移进入 `fallback` 且未被 `notify.pull` 读取的行会重新入队投递，而 transport 失败或幂等窗口超期进入 `fallback` 的行保持终态，避免重复投递。已 sent/read 的通知不会因 route 漂移重新入队。旧直连通知环境变量和 stdout fan-out 均不在当前投递路径中。

## 5. 确定性每日生活简报

`weather.daily_brief` 的 cron 来自 `DAILY_WEATHER_BRIEF_CRON`，默认 `0 7 * * *`；IANA 时区来自 `LIFE_ASSISTANT_TIMEZONE`，未配置时使用进程本地时区。

job 并发读取当前天气、当日预报和可选油价：

- 当前天气或预报单项失败时，使用另一个天气结果继续生成；
- 两个天气结果都不可用时，本轮失败，不发送空简报；
- 油价未配置、失败或为不可用占位值时省略油价；
- 使用 `weather:daily-brief:<城市>:<本地日期>` 作为 dedupe key，同日更换已保存位置后新城市简报不会被旧键吞掉；
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

### 平台渲染

`PROFILE_PUSH_ROUTES_JSON` 每个 Profile 条目可带可选字段 `renderTarget`，指定该 Profile 主动通知的平台渲染目标，取值为 `"plain"` / `"qq-markdown"` / `"feishu-markdown"` / `"wechat-markdown"` 四种；缺省或未知值一律回退 `"plain"`（`resolveRenderTarget` 在运行时解析，`parseProfilePushRoutes` 只保留合法取值）。

渲染统一走「阶段 B」结构化块中间表示（`RenderBlock[]` IR）：plain 与三个 markdown 平台都是同一份 `RenderBlock[]` 的确定性投影，不是各平台各写一套模板。markdown 快照形态为：title 为 `# <headline>`，body 由 markdown 块组成（`**标签**：值`、块间 `\n\n` 分段等）；官方原文（details 字段）走 raw 块原样输出，不解析不转义。`renderNotification` 中 qq/feishu/wechat 走同一套保守 markdown 投影，任何异常都回退 plain 兜底、不允许 throw；plain 或未知/非法 target 也走 plain 投影。

每 Profile 渲染通过 `publishGlobal` 的第 6 参 `renderForProfile(profileId, {title, body})` 回调实现：该回调只替换每个 Profile 的落库快照，suppressRetainedGlobal / legacy dedupe / delivery 创建逻辑一律不变；既有 5 参调用不受影响。通知快照在生成时按该 Profile 的 renderTarget 渲染并落库，之后不重渲染；因此 renderTarget 只影响配置变更之后新生成的通知，已落库的旧快照不会自动重渲染。

天气推断预警已信封化为 `weather.inferred_alert`（builder `inferredAlertNotification()`），经 `publishNotification`（publishGlobal 路径）按 Profile fan-out；identity 为 `inferred:<title>:<date>`，与 source 前缀组合成 dedupe key `weather:inferred:<title>:<date>`，与旧路径 dedupe 兼容（旧 legacy dedupe keys 保留）。plain 下 description 原样输出；markdown（qq/feishu/wechat 同集）下 label 块为 `**风险**` 加粗前缀。

天气 Open-Meteo 兜底的 WMO 天气码映射表（`WMO: Record<number, string>`）已补齐 53/55/56/57/66/67/77/85/86 等缺失码（如 55 = 密集毛毛雨），映射后不再出现原始 `code N` 回退；未知码仍保留 `code N` 兜底。天气 provider：QWeather 首选、Open-Meteo 兜底。

## 7. 中国大陆节假日历法

- **存储**：`cn_holiday_days(date PK, year, day_type holiday|workday, name, source, …)` 与 `cn_holiday_year_meta(year PK, status, source, payload_hash, fetched_at, last_attempt_at, last_error)`。只有 `status='ready'` 的年份参与日期分类。入库在单个事务中按**数据集实际覆盖日期范围**替换（不是按标题年整年删除），避免后抓相邻上一年文件时清掉另一标题年写入的 12 月下旬跨年行（H1）。`readHolidayYear(year)` 按标题年日期范围 `[year-1-12-20, year-12-19]` 读取，返回标题年完整数据（含跨年行，M3）。
- **自动获取**：`holiday.refresh_calendar` job（`HOLIDAY_REFRESH_CRON`，默认 `0 2 * * *`，Asia/Shanghai）每日确保当年数据；每年 10 月起额外尝试获取下一年安排。scheduler 启动时经模块 `onStart` 引导补齐。抓取失败写 `last_attempt_at/last_error` 并按 6 小时冷却重试。
- **数据源与门槛**：主源 holiday-cn（jsDelivr + raw.githubusercontent 镜像），独立兜底 chinese-days（npm/jsDelivr）。次年数据只有主源返回且携带国务院通知原文链接（`papers`）时才接受，兜底源不会被用于把预估值写成权威安排。每个候选源的返回数据集年份必须与请求年份一致（T1）。入库前做结构校验：日期必须是真实存在的规范日历日；按年份口径要求节日齐全（2008 年起七节日，2004–2007 仅元旦/春节/劳动节/国庆）；休假日落在合法日期窗口；补班日必须是周末；每个节日休假日连续；全年休假日总数 20–45（2004 年起统一口径）。
- **跨年元旦**：holiday-cn 年文件按国务院文件标题年份命名，仅放行「上一年 12/20 之后的元旦日期」作为跨年形态；下一年日期一律拒绝。入库仍按日期自然年写入 `cn_holiday_days`，按自然年查询可命中。`holidayYearView(year)` 按标题年日期范围 `[year-1-12-20, year-12-19]` 查询（K1：不含下一年标题年写入的 12 月下旬行），把 12/30–1/1 合并为同一连休期；补班日按「最近同名段 + 10 天窗口」关联，避免同名元旦段串染。chinese-days 是单自然年数据：year 文件不含上一年 12 月行，只有 year-1 同为 chinese-days 时视图才完整（N3/N4）——year-1 未 ready 或为 holiday-cn 时视图返回 undefined（unknown），`list` 入口经 `ensureYearForView` 仅在 year-1 未 ready 时尝试补齐，year-1 为 holiday-cn 时不覆盖既有数据、由视图层报错。`nextHoliday` 在当年未 ready 但下一年标题年已 ready 且 today 处于 12/20 后时继续扫描下一年（K3），双缺仍返回 unknown。
- **分类口径**：命中 `cn_holiday_days` 按行分类；未命中的日期默认周一至周五为工作日、周六日为休息日。
- **schedule 集成**：`workday`/`holiday` 频率仅支持公历与 `Asia/Shanghai`。occurrence 按天扫描，候选日期经日期级覆盖判断 `isDateCoveredByHolidayData`（M1/N1：12/20–12/31 仅当 year+1 为 holiday-cn 且 ready 时视为完整覆盖；否则自然年 ready 且命中权威行才算覆盖；其余日期看自然年标题年），未覆盖立即返回 null（无数据区间不触发，也不跨越缺失区间继续猜）；`until`/`count` 在扫描中生效。`createSchedule`/`updateSchedule`/`reconcileHolidaySchedules` 在算不出 next run 时调用 `holidayAwareRuleFinished`：`until/count` 真正耗尽 → `status='completed'`（archived 除外）；仅数据缺失 → 停用但保持 `active`，新数据入库后由 `reconcileHolidaySchedules` 恢复启用（派生状态重算不推进内容版本，冲突时放弃本轮）。
- **查询工具**：`holiday.next`（下一个/当前连休期、倒计时、调休上班日）、`holiday.list`、`holiday.is_workday`、`holiday.refresh`。`holiday.next` 只读，覆盖区间内没有后续数据时返回 unknown 提示；`list` 经 `ensureYearForView` 只确保标题年，并对 chinese-days 来源在 year-1 未 ready 时补齐上一自然年（N3/N4：year-1 为 holiday-cn 时不补齐、不覆盖，由视图 unknown/报错呈现）；`is_workday` 经 `ensureDayCoverage` 对 12/20–12/31 日期优先确保下一年标题年（K2）：仅 holiday-cn 的 year+1 视为权威覆盖（N2），自然年兜底必须命中目标日期的 holiday/workday 行，否则抛错而不是周历猜测（M2）。均按冷却窗口补齐（未来年份只走官方主源），仍不可用则明确报错，绝不按普通周历猜测。

## 8. 数据源

| 能力 | 首选 | 兜底 |
|---|---|---|
| 实时天气/预报 | QWeather（配置 Key 时） | Open-Meteo |
| 天气预警 | QWeather 官方预警 | Open-Meteo 阈值推断 |
| 当前油价 | TianAPI | JUHE；均不可用时返回说明 |
| 调价窗口 | 本地年度窗口表 | 无 |
| 节假日安排 | holiday-cn（jsDelivr + raw 镜像） | chinese-days（npm/jsDelivr） |

外部 HTTP 逻辑收敛在模块 `provider.ts` 和 `core/http.ts`。快递模块已封存且未注册到运行时。

## 9. 演进原则

迁移保持 additive，并保留旧数据读取兼容。新增模块不得直绑消息平台；新增私有数据必须带 Profile 所有权；新增公共 job 必须接受按配置 Profile 独立 materialize 的语义。动态 automation 是未来扩展层，不得在实现前写成当前功能。
