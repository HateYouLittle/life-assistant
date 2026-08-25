---
name: life-assistant
description: "Use for weather, air quality, life indices, oil prices, mainland China statutory holidays and workdays, Profile-private schedules, dynamic automations, notification management (quiet hours, snooze, cancel), backup/migration, pending notification recovery, or switching the Hermes notification platform."
summary: "天气、空气质量、生活指数、油价、节假日/工作日、Profile 私有日程与自动任务、静默时段等通知管理、备份迁移；主动通知统一经 Hermes Webhook。"
read_when:
  - 用户询问天气、气温、穿衣、降水、气象预警、空气质量、AQI、雾霾或紫外线
  - 用户询问油价、加油、调价、涨价或降价
  - 用户询问放假、节假日、调休、补班、工作日或放假倒计时
  - 用户提到待办、提醒、日程、生日、纪念日或农历日期
  - 用户想要条件触发的动态提醒（如「明天下雨早上提醒我」「空气差了叫我」）
  - 用户要求免打扰、静默时段、稍后提醒、取消提醒或排查没收到的通知
  - 用户要求备份、导出或迁移生活助理数据
  - 用户要求切换 QQ、微信、飞书等主动通知平台
  - 会话开始，需要恢复未成功主动投递的通知
---

# Life Assistant

Hermes 将 MCP 工具注册为 `mcp_life_assistant_<tool>`，点号转换为下划线。例如 `weather.current` 对应 `mcp_life_assistant_weather_current`。

## 每次会话

调用一次 `notify.pull`，转述当前 Profile 尚未成功主动投递的通知。没有结果则不提。Webhook 已成功投递的通知不会再次返回；失败、fallback 或未配置 route 的通知才由 pull 恢复。

`HERMES_PROFILE` 是日程所有权边界。不得跨 Profile 查询、修改或转述日程及日程通知。

## 位置

天气或油价依赖位置时先调用 `location.get`：

- `confirmed`：直接使用。
- `need_confirm`：把 suggestion 自然地请用户确认；确认后调用 `location.set`，suggestion 含 `province` 时一并传回。
- suggestion 不正确：询问城市名，调用 `location.detect(city)`，再让用户确认并调用 `location.set`；保留 detect 返回的 `province`。

用户只查询其他城市时，直接给天气工具传 `city`，不要修改已保存位置，也不要要求用户提供经纬度。

## 天气、空气与油价

- 当前天气用 `weather.current`，未来天气用 `weather.forecast(days)`，当前预警用 `weather.alerts`，穿衣/洗车/紫外线等生活指数用 `weather.indices`。
- 空气质量用 `airquality.current`；注意返回的 `scale`（CN 国标 / US 美标），两种量表数值不可直接比较；未配置和风 Key 时为美标兜底，回答时应带量表说明。
- 回答应包含地点、单位和有用的穿衣、降水或出行建议，不只复述字段。
- 当前油价用 `oilprice.current`；调价时间和是否提前加油用 `oilprice.next_adjustment`。
- 油价 Provider 优先 TianAPI，失败且配置 JUHE 时回退 JUHE。两者均未配置或不可用时，按工具返回的说明告知用户，不要假定只需要某一个 Key。
- 内置每日生活简报仅由当前天气和当日预报确定性生成，不包含油价，不调用 LLM；不要另建 LLM cron 重复实现它。

天气、油价、预警和生活简报是公共事件，会按已配置的 Profile route 各生成一份隔离投递。位置与 Provider 数据共享，但每个 Profile 独立接收和标记通知。

## 节假日与工作日

中国大陆法定节假日数据是共享数据，由 scheduler 自动获取，不要向用户索取或自行编造安排。

- 距离下次放假还有多久 → `holiday.next`；返回 ongoing 时说明正在假期中并给出剩余天数，返回 unknown 时说明安排尚未获取、会稍后自动更新。
- 某年完整安排 → `holiday.list(year)`；判断某天是否上班 → `holiday.is_workday(date?)`。
- 法定工作日 = 周一至周五 − 法定节假日 + 调休上班的周末；法定节假日休假日不含普通周末。回答时把调休上班日一并说明。
- 数据缺失且工具报错时，如实告知「官方安排尚未获取，scheduler 会在发布窗口自动更新」；必要时用 `holiday.refresh` 补抓，不要用周一至周五的普通周历去猜节假日。

## 日程

- 创建、查询、修改、完成和删除使用 `schedule.*`；不要传 `profileId`。
- 普通待办默认公历。生日或纪念日若使用农历，传 `calendar: "lunar"`、`lunarMonth`、`lunarDay`。
- 创建前确认用户说的是公历还是农历。`leapMonthPolicy: "leap"` 的事件仅在对应闰月年份触发。
- 中国大陆法定工作日重复提醒用 `recurrence: "workday"`（如「每个法定工作日 09:00」）；仅放假日的提醒用 `recurrence: "holiday"`。两者只支持公历和 `Asia/Shanghai` 时区，不支持 interval/byWeekday/byMonthDay。
- 用户想要「没确认就一直提醒」时用强提醒：`schedule.create` 传 `intervalMinutes`（1–10080 分钟，默认 120）与/或 `maxAttempts`（1–99 轮，默认 3），到期未确认完成会按间隔重复提醒直至完成/删除/达上限；`schedule.update` 传 `clearStrongReminder: true` 关闭。强提醒需要一条 occurrence 正式提醒（`target: "occurrence"` 且 `minutesBefore: 0`，默认提醒即满足），只配提前提醒/截止提醒会被拒绝。
- 强提醒 `intervalMinutes` 大于等于 recurrence 触发间隔（daily=1440 分钟、weekly=10080 分钟）时重发不生效，会被下一 occurrence 的正式提醒接管；遇到该场景如实向用户说明（该间隔警告仅适用于未配 `byWeekday` 的 daily/weekly，配了 `byWeekday` 时实际触发间隔不定，不输出警告）。
- 日程和日程通知只属于当前 Profile。不得因为天气/油价公共 fan-out 而扩大日程作用域。

## 自动任务 automation

用户想要条件触发的动态提醒（「明天下雨就提醒我」「AQI 超过 150 叫我」「油价破 8 通知」）时使用 `automation.*`，不要把它们建成一堆静态日程：

- 用 `automation.create` 创建：`action` 限白名单（`weather.current` / `weather.forecast` / `airquality.current` / `oilprice.current`），`condition` 是 `{field, op, value}`（field 用 dot-path，如 `today.precipAmountMm`、`aqi`、`p92`；`today.precipProb` 仅 Open-Meteo 数据源有值，和风路径用 `precipAmountMm`），`schedule` 是 daily（可带时区）或 interval（≥5 分钟）。
- 无条件表示到点必提醒；条件不满足则本轮静默。同一任务每个本地日期最多主动提醒一次。
- 创建后用 `automation.run` 立即执行一次验证配置，把结果如实反馈给用户；`automation.list` 查看运行状态与最近错误。
- 修改用 `automation.update`（condition 传 null 清除），删除用 `automation.delete`。任务和通知只属于当前 Profile。
- 白名单之外的数据源需求当前无法配置为 automation，如实说明即可，不要伪造任务。

## 定时任务边界

- 静态或重复个人提醒：使用 `schedule.create`。
- 条件触发的动态提醒（基于天气/空气/油价等白名单数据源）：使用 `automation.*`。
- 白名单之外数据源的固定推送：需要项目实现 code-defined `AssistantModule` job；当前没有通用自然语言 automation，不要假装已创建可执行的动态任务。

## 通知管理（静默时段 / 稍后提醒 / 取消）

- 免打扰：`notify.quiet_hours` 设置（如 22:00–07:00，支持跨午夜与自定义时区）；窗口内不主动投递，窗口结束自动补投，`notify.pull` 不受影响。无参查询，`clear: true` 清除。
- 「这个提醒晚点再说」：`notify.snooze`（1–1440 分钟），只对未成功投递的通知有效，已 sent/已取消的会返回错误说明。
- 「这条提醒不要了」：`notify.cancel`；已 sent 的不受影响，取消后 pull 也不再复述。
- 排查「为什么没收到通知」：`notify.list` 查看通知与投递状态（sent/pending/failed/fallback/cancelled），再决定 snooze、cancel 还是等待补投。

## 备份与迁移

- `assistant.export` 导出当前 Profile 快照（日程全量、自动任务、静默时段、位置），让用户保存 JSON 文件。
- `assistant.import` 导入：按 ID 幂等（已存在跳过），位置是共享数据，只有用户明确同意时才传 `applyLocation: true`。

## 通知平台切换

平台由 Hermes 动态 `deliver-only` Webhook subscription 管理。模块不得直接发送 Bark、Server酱、QQ 或微信。

- 单目标切换只重建对应 Profile 的同名 subscription，并修改 `--deliver`。
- 保持 route 名、loopback URL 和 HMAC secret 不变时，不修改 SQLite 或 scheduler，通常也不重启 Gateway。
- route 名、URL、secret 或 `renderTarget` 变化时，必须同步 `PROFILE_PUSH_ROUTES_JSON` 并重启 scheduler 与读取该配置的 MCP 进程。
- secret 必须是安全保存的 64 位随机十六进制值，不得输出到聊天、日志或 Git。
- 当前每个 Profile 只有一个主动目标；用户要求多平台同时投递时，说明当前不支持，不要伪造配置。
- 切换后用对应 Profile 的 `hermes webhook list` 和临时日程做端到端验证。

## 通知平台渲染

- `PROFILE_PUSH_ROUTES_JSON` 每个 Profile 条目可配置可选 `renderTarget`：`"plain"`（纯文本，缺省兜底）、`"qq-markdown"`、`"feishu-markdown"`、`"wechat-markdown"`；缺省或未知值一律按 `"plain"` 处理。
- 通知快照在生成时按该 Profile 的 `renderTarget` 渲染并落库，之后不重渲染；修改配置只影响之后新生成的通知，已落库的旧快照不会自动重渲染。
- `renderTarget` 或 `PROFILE_PUSH_ROUTES_JSON` 任一字段变化后，需重启 scheduler 与读取该配置的 MCP 进程才会生效。
- QQ / 飞书 / 微信共用同一套 markdown 投影，plain 是缺省与兜底；平台渲染异常不会导致通知发送失败。

## 已封存能力

快递追踪未注册到运行时。不要调用或声称存在相关工具；建议用户使用电商平台或快递公司的官方渠道。
