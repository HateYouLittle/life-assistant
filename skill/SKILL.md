---
name: life-assistant
summary: "个人生活助理：共享天气/油价与 Profile 私有日程，支持公历和中国农历生日提醒。适配 Hermes Agent。"
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

调用一次 `notify.pull`，把当前 Profile 未读的公共通知（天气预警、油价预通知）和本 Profile 的私有日程提醒用自然、简洁的话转述给用户。没有未读通知则不提此事。

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

## 油价

- 当前油价 → `oilprice.current`（92#/95#/0#）。
- 调价窗口 → `oilprice.next_adjustment`。当用户问"什么时候调价/要不要提前加油"时，结合倒计时给建议。
- 若返回"未配置数据源"，告知用户需要配置 `JUHE_KEY` 并指向 README。

## 日程、生日和纪念日

- 创建/查询/修改/完成/删除日程使用 `schedule.*` 工具；工具自动绑定当前 Profile，不要传 `profileId`。
- 待办默认使用公历；生日和纪念日可以使用中国农历：传 `calendar: "lunar"`、`lunarMonth`、`lunarDay`。
- 农历生日按当年转换为公历日期再提醒；普通月每年触发，`leapMonthPolicy: "leap"` 的闰月生日在非对应闰月年份跳过。
- 创建前确认用户说的是公历还是农历；返回结果时同时说明农历字段和实际触发的公历日期，避免日期错位。
- 日程提醒优先通过当前 Profile 的 Hermes `deliver-only` Webhook 主动发送到 QQ；成功后 `notify.pull` 不重复播报，失败或未配置时保留在私有队列兜底。
- 私有日程不会发送到没有 Profile 路由的公共 webhook/Bark/Server酱。

## 快递（已封存，暂不可用）

快递追踪模块已封存下线（2026-08-01，省 API 额度；电商平台自带物流推送）。
用户问快递时：告知暂无此功能，建议查电商平台/快递公司官方渠道。恢复时再启用。

## 表达风格

- 主动通知转述要有温度但不啰嗦，一条通知一两句话。
- 数据带上单位与地点（如"北京，26℃，东南风 3 级"）。
