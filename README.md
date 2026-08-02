# Life Assistant — 个人生活助理（Skill + MCP Server）

适配 **Hermes Agent** 的个人生活助理。当前提供公共生活信息与 Profile 私有日程能力：

| 功能 | 说明 |
|---|---|
| ⛈ 天气查询与主动预警 | 实时天气、未来预报；恶劣天气自动监测并主动推送 |
| ⛽ 油价查询与调价预通知 | 当地 92#/95#/0# 油价；发改委调价窗口前 24h 主动预通知 |
| 📅 Profile 私有日程 | 待办、生日、纪念日；支持公历和中国农历，提醒按 Profile 隔离 |

架构与扩展设计详见 [docs/architecture.md](docs/architecture.md)。

## 特性

- **Skill + MCP 双形态**：`skill/SKILL.md` 教 Agent 何时用、怎么用；MCP Server 提供工具
- **主动推送**：公共通知支持原有通道；Profile 私有日程通过 Hermes `deliver-only` Webhook 主动投递，并有 `notify.pull` 拉取兜底
- **插件化模块**：新功能实现 `AssistantModule` 接口、注册一行即可，核心零改动
- **低成本数据源**：Open-Meteo（免费无 Key）、和风天气免费版、聚合数据油价（低成本）、本地调价窗口推算（免费）
- **Profile 隔离**：天气/油价数据和公共通知共享；日程、提醒和日程通知严格绑定 `HERMES_PROFILE`
- **中国农历**：生日/纪念日可保存农历月日，按当年转换为公历触发；闰月生日默认只在对应闰月年份提醒
- **首次运行位置确认**：IP 自动探测给建议值，Agent 用自然语言向用户确认一次后落盘

## 快速开始

```bash
npm install
cp .env.example .env   # 按需填写（全部可留空，留空也能跑）
npm run build
```

> 当前 SQLite 实现使用 Node 内置 `node:sqlite`，运行环境要求 Node >= 22.5。

### 1. 接入 Hermes Agent（MCP Server）

在 Hermes 的 MCP 配置中加入：

```json
{
  "mcpServers": {
    "life-assistant": {
      "command": "node",
      "args": ["/path/to/life-assistant/dist/index.js"],
      "env": { "DATA_DIR": "/path/to/life-assistant/data", "HERMES_PROFILE": "default" }
    }
  }
}
```

再把 `skill/SKILL.md` 安装到 Hermes 的技能目录。

### 2. 启动唯一主动通知调度进程

```bash
npm run start:scheduler     # 或 pm2 start dist/scheduler.js --name life-assistant
```

不启动调度进程也能用全部查询工具，只是没有主动提醒。配置 `PROFILE_PUSH_ROUTES_JSON` 后，日程通知会进入可靠 outbox 并主动投递到目标 Profile；发送失败时仍保留在 `notify.pull`。同一个 `DATA_DIR` 只应运行一个 scheduler。

## 接入 Hermes Agent（详细步骤）

Hermes 内置原生 MCP 客户端（`native-mcp` 技能），启动时自动连接 `mcp_servers` 里配置的服务并发现工具。

### 前置条件

```bash
pip install mcp    # Hermes 的 MCP 客户端依赖；未安装则 MCP 支持被静默禁用
```

### 1. 注册 MCP Server

编辑 `~/.hermes/config.yaml`，在 `mcp_servers` 下添加（**整个文件只能有一个 `mcp_servers:` 块**，已有其他配置请合并，否则会被静默丢弃）：

```yaml
mcp_servers:
  life-assistant:
    command: "node"
    args: ["/绝对路径/life-assistant/dist/index.js"]
    env:
      DATA_DIR: "/绝对路径/life-assistant/data"
      HERMES_PROFILE: "default"  # 必须显式设置；其他 Profile 使用自己的值
      QWEATHER_KEY: ""          # 可选：和风天气（官方预警）
      JUHE_KEY: ""              # 可选：聚合数据（油价）
      KUAIDI100_CUSTOMER: ""    # 快递100
      KUAIDI100_KEY: ""         # 快递100
      NOTIFY_WEBHOOK_URL: ""    # 可选：主动通知 webhook
      BARK_URL: ""              # 可选：iOS Bark 推送
      SERVERCHAN_SENDKEY: ""    # 可选：Server酱微信推送
    timeout: 120
```

### 2. 安装 Skill

```bash
mkdir -p ~/.hermes/skills/life-assistant
cp skill/SKILL.md ~/.hermes/skills/life-assistant/SKILL.md
```

### 3. 启动唯一调度进程（主动推送能力）

```bash
npm run start:scheduler        # 前台
# 生产建议托管：pm2 start dist/scheduler.js --name life-assistant-scheduler
```

### 4. 重启 Hermes 并验证

```bash
hermes mcp list                    # life-assistant 应显示已连接
hermes tools list | grep life      # 应看到 15 个工具
hermes skills list | grep life     # 技能应已加载
```

**工具名映射**：Hermes 注册为 `mcp_life_assistant_<工具名>`（点号转下划线），如 `weather.current` → `mcp_life_assistant_weather_current`。

接入后首次对话，Agent 会按 Skill 指引自动走位置确认流程。

## 配置（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `LOCATION_CITY/LAT/LON` | 否 | 预置位置；不填则首次运行由 Agent 引导确认 |
| `QWEATHER_KEY` | 否 | 和风天气 Key（官方预警；不填降级为阈值推断） |
| `JUHE_KEY` | 否 | 聚合数据油价 Key |
| `KUAIDI100_CUSTOMER/KEY` | 否* | 快递100 授权（*快递功能必填） |
| `NOTIFY_WEBHOOK_URL` / `BARK_URL` / `SERVERCHAN_SENDKEY` | 否 | 主动推送通道，可配多个 |
| `PROFILE_PUSH_ROUTES_JSON` | 否 | Profile 私有 `deliver-only` Webhook 路由；HMAC secret 为 64 位随机十六进制值，`.env` 必须为 `600` |

## 切换 Profile 主动推送平台

Life Assistant 不直接绑定 QQ SDK；它把私有提醒投递到 Hermes 的 `deliver-only` Webhook，再由 Hermes 选择目标平台。因此，**单个平台切换通常不需要改代码、不需要迁移 SQLite**。

当前部署的动态订阅是：

```text
default → life-assistant-reminder-default → qqbot
bestie  → life-assistant-reminder-bestie  → qqbot
```

### 只切换一个 Profile 的目标平台

先确保目标平台已经在对应 Hermes Profile 中配置好账号、Home 会话或目标 chat ID。然后删除旧订阅，用相同的 route 名、URL 和 HMAC secret 重建；只把 `--deliver qqbot` 换成目标平台，例如 `weixin` 或 `feishu`：

```bash
# default：QQ → 微信（示例）
hermes webhook remove life-assistant-reminder-default
hermes webhook subscribe life-assistant-reminder-default \
  --prompt $'🎂 {notification.title}\n\n{notification.body}' \
  --deliver weixin \
  --deliver-only \
  --secret "$DEFAULT_ROUTE_SECRET"

# bestie：QQ → 微信（示例）
hermes -p bestie webhook remove life-assistant-reminder-bestie
hermes -p bestie webhook subscribe life-assistant-reminder-bestie \
  --prompt $'🎂 {notification.title}\n\n{notification.body}' \
  --deliver weixin \
  --deliver-only \
  --secret "$BESTIE_ROUTE_SECRET"
```

- 不要把真实 secret 粘贴到聊天、脚本或 Git；从权限为 `600` 的 secret 文件安全加载到环境变量。
- 仅更换 `--deliver` 时，`PROFILE_PUSH_ROUTES_JSON`、scheduler 和 SQLite 不需要修改。
- 动态订阅会热加载，通常不需要重启 gateway；如果同时修改了 Hermes 平台凭据或平台配置，才重启对应 Profile 的 gateway。
- 如果修改了 route 名、URL 或 HMAC secret，必须同步更新项目 `.env` 的 `PROFILE_PUSH_ROUTES_JSON`，然后重启 scheduler。
- 切换后用 `hermes webhook list`（bestie 使用 `hermes -p bestie webhook list`）确认目标，再创建一条临时日程做端到端测试。

### 回滚与多平台限制

回滚就是把 `--deliver weixin/feishu` 改回 `--deliver qqbot`，其它参数保持不变。当前配置模型是**每个 Profile 一个主动推送目标**；如果要同一提醒同时发 QQ、微信、飞书，需要把 Profile route 配置扩展为多个 route，并为每条 route 建立独立 outbox。`notify.pull` 始终是私有兜底，不随平台切换消失。

## 工具一览

`location.get/set/detect` · `weather.current/forecast/alerts` · `oilprice.current/next_adjustment` · `schedule.create/list/get/update/complete/delete` · `notify.pull`

## 日程与中国农历

日程工具不接受 `profileId` 参数，而是自动绑定当前 MCP 进程的 `HERMES_PROFILE`。Profile 缺失或非法时直接拒绝访问，避免误落入 `default`。

- `calendar: "solar"`：使用 `date: "YYYY-MM-DD"`。
- `calendar: "lunar"`：使用 `lunarMonth`、`lunarDay`，不能把农历日期当作公历 `date`。
- 农历生日/纪念日按每年转换为当年的公历日期；普通月每年触发。
- `leapMonthPolicy: "leap"` 表示只在对应闰月年份触发；没有对应闰月的年份默认跳过。
- 配置 Profile 私有 Webhook 后，日程提醒会由 scheduler 通过 HMAC V2 主动投递；明确失败按 1m/5m/15m/1h 退避重试，网络结果不确定时复用请求 ID 防重复。
- QQ/其他主动投递成功后，`notify.pull` 不会重复播报；主动投递失败或未配置时仍通过当前 Profile 的 `notify.pull` 兜底。

## 新增一个功能模块（5 分钟）

```ts
// src/modules/mymodule/index.ts
import { registerModule, ok, type AssistantModule } from "../../core/registry.js";

const mod: AssistantModule = {
  name: "mymodule",
  tools: [{ name: "hello", description: "...", schema: {}, handler: async () => ok("hi") }],
  jobs:  [{ name: "tick", cron: "0 8 * * *", handler: async ({ notify }) => { await notify("早安", "..."); } }],
};
registerModule(mod);
```

然后在 `src/modules/index.ts` 加一行 `import "./mymodule/index.js";` —— 完成。

## Roadmap

- v0.2 SQLite 存储、更多通知通道（钉钉/飞书/邮件）
- v0.3 已完成 Profile 专属 Hermes Webhook outbox；后续增加静默时段、snooze
- v0.4 多位置/多用户、Web 配置面板

## 贡献

欢迎 PR！请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。年度调价窗口表（`src/modules/oilprice/schedule.ts`）每年初需要按发改委公告校准，这是新手友好的贡献点。

## License

[MIT](LICENSE)
