---
name: life-assistant
description: "Use for weather, oil prices, Profile-private schedules and reminders, pending notification recovery, or switching the Hermes notification platform."
summary: "天气、油价、确定性生活简报与 Profile 私有日程；主动通知统一经 Hermes Webhook。"
read_when:
  - 用户询问天气、气温、穿衣、降水或气象预警
  - 用户询问油价、加油、调价、涨价或降价
  - 用户提到待办、提醒、日程、生日、纪念日或农历日期
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

## 天气与油价

- 当前天气用 `weather.current`，未来天气用 `weather.forecast(days)`，当前预警用 `weather.alerts`。
- 回答应包含地点、单位和有用的穿衣、降水或出行建议，不只复述字段。
- 当前油价用 `oilprice.current`；调价时间和是否提前加油用 `oilprice.next_adjustment`。
- 油价 Provider 优先 TianAPI，失败且配置 JUHE 时回退 JUHE。两者均未配置或不可用时，按工具返回的说明告知用户，不要假定只需要某一个 Key。
- 内置每日生活简报由当前天气、当日预报和可用油价确定性生成，不调用 LLM；不要另建 LLM cron 重复实现它。

天气、油价、预警和生活简报是公共事件，会按已配置的 Profile route 各生成一份隔离投递。位置与 Provider 数据共享，但每个 Profile 独立接收和标记通知。

## 日程

- 创建、查询、修改、完成和删除使用 `schedule.*`；不要传 `profileId`。
- 普通待办默认公历。生日或纪念日若使用农历，传 `calendar: "lunar"`、`lunarMonth`、`lunarDay`。
- 创建前确认用户说的是公历还是农历。`leapMonthPolicy: "leap"` 的事件仅在对应闰月年份触发。
- 日程和日程通知只属于当前 Profile。不得因为天气/油价公共 fan-out 而扩大日程作用域。

## 定时任务边界

- 静态或重复个人提醒：使用 `schedule.create`。
- 需要实时天气、油价或其他动态数据的固定推送：当前必须由项目实现 code-defined `AssistantModule` job，并通过标准通知接口发布。
- 通用自然语言 automation 当前未实现。面对这类需求，应明确说明需要新增模块 job 或等待 planned automation，禁止假装已创建可执行的动态任务。

## 通知平台切换

平台由 Hermes 动态 `deliver-only` Webhook subscription 管理。模块不得直接发送 Bark、Server酱、QQ 或微信。

- 单目标切换只重建对应 Profile 的同名 subscription，并修改 `--deliver`。
- 保持 route 名、loopback URL 和 HMAC secret 不变时，不修改 SQLite 或 scheduler，通常也不重启 Gateway。
- route 名、URL 或 secret 变化时，必须同步 `PROFILE_PUSH_ROUTES_JSON` 并重启 scheduler。
- secret 必须是安全保存的 64 位随机十六进制值，不得输出到聊天、日志或 Git。
- 当前每个 Profile 只有一个主动目标；用户要求多平台同时投递时，说明当前不支持，不要伪造配置。
- 切换后用对应 Profile 的 `hermes webhook list` 和临时日程做端到端验证。

## 已封存能力

快递追踪未注册到运行时。不要调用或声称存在相关工具；建议用户使用电商平台或快递公司的官方渠道。
