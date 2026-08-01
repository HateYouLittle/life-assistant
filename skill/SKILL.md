---
name: life-assistant
summary: "个人生活助理：天气查询与恶劣天气预警、油价查询与调价预通知、快递动态追踪通知。适配 Hermes Agent，通过 life-assistant MCP Server 提供能力。"
read_when:
  - 用户询问天气、气温、穿什么、要不要带伞
  - 用户询问油价、加油、调价、涨价/降价
  - 用户提到快递、包裹、物流、单号、到哪了、签收
  - 会话开始（拉取待读主动通知）
---

# Life Assistant — 个人生活助理

你接入了 `life-assistant` MCP Server。以下规则帮助你正确使用它。

> 工具名映射：Hermes 会将工具注册为 `mcp_life_assistant_<tool>` 形式（点号转下划线）。
> 本文中的 `weather.current` 即 Hermes 工具表里的 `mcp_life_assistant_weather_current`，以此类推。

## 会话开始（每次必做）

调用一次 `notify.pull`，把未读的主动通知（天气预警、油价预通知、快递动态）用自然、简洁的话转述给用户。没有未读通知则不提此事。

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

## 快递（已封存，暂不可用）

快递追踪模块已封存下线（2026-08-01，省 API 额度；电商平台自带物流推送）。
用户问快递时：告知暂无此功能，建议查电商平台/快递公司官方渠道。恢复时再启用。

## 表达风格

- 主动通知转述要有温度但不啰嗦，一条通知一两句话。
- 数据带上单位与地点（如"北京，26℃，东南风 3 级"）。
