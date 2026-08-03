---
name: life-assistant
description: "Use when users ask about weather, schedules, reminders, or notification platform switching."
summary: "个人生活助理：天气/油价、确定性晨间简报与 Profile 私有日程，统一通过 Hermes Webhook 主动通知。"
read_when:
  - 用户询问天气、气温、穿什么、要不要带伞
  - 用户询问油价、加油、调价、涨价/降价
  - 用户提到待办、日程、生日、纪念日、农历生日
  - 会话开始（拉取待读主动通知）
---

# Life Assistant — 个人生活助理

你接入了 `life-assistant` MCP Server。以下规则帮助你正确使用它。

> 工具名映射：Hermes 会将工具注册为 `mcp_life_assistant_<tool>` 形式（点号转下划线）。
> 本文中的 `weather.current` 即 Hermes 工具表里的 `mcp_life_assistant_weather_current`，以此类推。

## 会话开始（每次必做）

调用一次 `notify.pull`，恢复当前 Profile 尚未成功主动投递的天气/油价通知和私有日程提醒，并用自然、简洁的话转述。没有未读通知则不提；已成功通过 Webhook 推送的通知不会再次出现。

> MCP 配置必须显式注入 `HERMES_PROFILE`。日程数据和日程通知不能跨 Profile 查询或转述。

## 位置确认（首次使用必做）

任何依赖位置的功能（天气、油价）调用前，先 `location.get`：

- 返回 `confirmed` → 直接使用；
- 返回 `need_confirm` → 把 `suggestion` 用自然语言向用户确认，例如："检测到你可能在**北京**，天气和油价需要这个位置，对吗？"
  - 用户确认 → `location.set(city, lat, lon)`；
  - 用户说不对 → 问清城市名，`location.detect(city)` 拿到坐标后再 `location.set`。

确认一次即可，之后不要再反复询问。

## 天气

- 实时天气 → `weather.current`；未来几天 → `weather.forecast(days)`；预警 → `weather.alerts`。
- **查任意城市**：用户问"XX市/XX区天气"（尤其不是已保存位置时），直接给天气工具传 `city` 参数（如 `weather.forecast(city: "朔城区", days: 1)`），**不要**改全局位置、**不要**让用户发经纬度。工具内部会解析城市并临时查询，不改动已保存位置。
- 回答时给实用建议（穿衣、带伞、洗车、运动），不要只念数据。
- 恶劣天气预警由后台调度自动推送；用户主动问时才调 `weather.alerts`。
- 每天本地时间 07:00 的生活简报由 Life Assistant 使用天气 Provider 确定性生成，可用时附带油价，不调用 LLM。

## 油价

- 当前油价 → `oilprice.current`（92#/95#/0#）。
- 调价窗口 → `oilprice.next_adjustment`。当用户问"什么时候调价/要不要提前加油"时，结合倒计时给建议。
- 若返回"未配置数据源"，告知用户需要配置 `JUHE_KEY` 并指向 README。

## 日程、生日和纪念日

- 创建/查询/修改/完成/删除日程使用 `schedule.*` 工具；工具自动绑定当前 Profile，不要传 `profileId`。
- 待办默认使用公历；生日和纪念日可以使用中国农历：传 `calendar: "lunar"`、`lunarMonth`、`lunarDay`。
- 农历生日按当年转换为公历日期再提醒；普通月每年触发，`leapMonthPolicy: "leap"` 的闰月生日在非对应闰月年份跳过。
- 创建前确认用户说的是公历还是农历；返回结果时同时说明农历字段和实际触发的公历日期，避免日期错位。
- 所有模块主动通知都先进入当前 Profile 的持久 outbox，再通过 Hermes `deliver-only` Webhook 发送到当前配置目标平台；成功后 `notify.pull` 不重复播报，失败或未配置时保留恢复队列。
- 公共天气/油价事件会为每个配置的 Profile route 各生成一份隔离投递；私有日程只生成所属 Profile 的投递。Bark、Server酱和通用直连 webhook 不参与发送。

## 主动推送平台切换

当用户要求“换 QQ/微信/飞书/其他消息平台”时，先区分是**切换单一目标**还是**同时增加多个目标**：

- 单一目标切换：不改 Life Assistant 代码、不迁移 SQLite；在对应 Hermes Profile 删除并重建同名动态 Webhook 订阅，把 `--deliver qqbot` 替换为目标平台（如 `weixin`、`feishu`）。default 使用 `hermes webhook ...`，bestie 使用 `hermes -p bestie webhook ...`。
- 订阅模板保持 `{notification.title}` 和 `{notification.body}`；HMAC secret 必须保持原值或用新的 64 位随机十六进制值，不能写进聊天、Git 或普通日志。
- 仅修改动态订阅目标时通常不重启 gateway；修改 Hermes 平台凭据或配置时重启对应 Profile 的 gateway。
- 修改 route 名、URL 或 secret 时同步更新 `PROFILE_PUSH_ROUTES_JSON`，并重启 scheduler；只修改 `--deliver` 不需要改该变量。
- 切换后用 `webhook list` 和一条临时日程做端到端验证；验证完成删除临时日程。失败时保留 `notify.pull` 作为兜底。
- 当前每个 Profile 只有一个主动推送目标；用户要求 QQ+微信同时发送时，不要假装配置已支持，应说明当前架构刻意只选择一个 Hermes Gateway 目标。

## 旧天气 Cron 迁移

外部 Hermes 07:00 LLM 天气 cron 与本仓库无关，不能在未确认时修改。部署并验证 Life Assistant 的确定性简报后，应向用户说明可能重复通知并请求确认；只有得到明确确认，才停用或删除旧 Hermes cron。不要仅修改旧任务的 `--deliver`，因为它仍依赖 LLM model/provider。

## 快递（已封存，暂不可用）

快递追踪模块已封存下线（2026-08-01，省 API 额度；电商平台自带物流推送）。
用户问快递时：告知暂无此功能，建议查电商平台/快递公司官方渠道。恢复时再启用。

## 表达风格

- 主动通知转述要有温度但不啰嗦，一条通知一两句话。
- 数据带上单位与地点（如"北京，26℃，东南风 3 级"）。
