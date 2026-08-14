# Life Assistant - Hermes 个人生活助理

Life Assistant 是面向 Hermes Agent 的 Skill + MCP 服务，提供天气、油价和 Profile 私有日程，并通过可靠 outbox 将主动通知交给 Hermes Gateway 投递。

| 能力 | 当前行为 |
|---|---|
| 天气 | 实时天气、7 日预报、气象预警、确定性每日生活简报 |
| 油价 | 当前 92#/95#/0# 油价、下一次调价窗口与提前通知 |
| 日程 | 待办、生日、纪念日；支持公历、中国农历和重复提醒 |
| 通知 | Profile SQLite outbox、Hermes HMAC V2 `deliver-only` Webhook、`notify.pull` 失败兜底 |

当前共注册 15 个 MCP 工具。快递追踪已经封存，未注册到运行时。

## 架构概览

```text
Hermes Profile -> stdio MCP -> 查询工具 / Profile 私有日程
                                  |
独立 scheduler -> 模块 job / 日程扫描 -> SQLite Profile outbox
                                               |
                                               v
                             Hermes deliver-only Webhook
                                               |
                                               v
                                  该 Profile 的一个 Gateway 平台

已 materialize 的投递失败/fallback 通知
或无 route 的 Profile 私有日程 -> 所属 Profile 的 notify.pull
```

- MCP 进程只处理查询和工具调用，不运行 cron。
- `src/scheduler.ts` 是唯一常驻调度器，执行模块 cron、日程扫描和 outbox 投递。
- 所有进程必须使用同一个绝对 `DATA_DIR`。同一 `DATA_DIR` 只能运行一个 scheduler。
- 位置、天气和油价数据共享；日程及日程通知严格按 `HERMES_PROFILE` 隔离。
- 公共天气、油价和生活简报事件只为 `PROFILE_PUSH_ROUTES_JSON` 中的 Profile 独立 materialize；未配置 route 的 Profile 不会通过 `notify.pull` 收到这些公共事件。
- Profile 私有日程通知即使没有 route 仍可 pull；已经 materialize 但投递失败或进入 fallback 的通知也保持可 pull。

长期设计与投递语义见 [docs/architecture.md](docs/architecture.md)。

## 安装

要求 Node.js >= 22.13（`node:sqlite` 从该版本起无需 `--experimental-sqlite` flag）和已安装的 Hermes CLI。

```bash
npm install
cp .env.example .env
chmod 600 .env
npm run build
```

将 `.env` 中的 `DATA_DIR` 改为绝对路径。Node 进程不会自动读取 `.env`；下文的 systemd unit 使用 `EnvironmentFile` 加载它，前台调试时需要先在 shell 中加载：

```bash
set -a
source .env
set +a
```

## 注册 Hermes MCP Server

优先使用 Hermes CLI 管理 MCP，不直接手改 `config.yaml`。先准备项目绝对路径并加载项目 `.env`：

```bash
LIFE_ASSISTANT_DIR=/absolute/path/to/life-assistant
set -a
source "$LIFE_ASSISTANT_DIR/.env"
set +a
```

`.env` 中的 `DATA_DIR` 必须是一个绝对路径。所有 MCP Profile 与 scheduler 必须使用这同一个值；`HERMES_PROFILE` 必须显式设置。`--args` 会消费后续参数，因此必须放在命令最后。

```bash
hermes mcp add life-assistant \
  --command node \
  --env DATA_DIR="$DATA_DIR" HERMES_PROFILE=default \
  --args "$LIFE_ASSISTANT_DIR/dist/index.js"
```

注册时 Hermes 会连接服务、列出发现的工具，并交互询问是否启用全部工具；请在可交互终端中确认。若名称已存在，还会先询问是否覆盖。

其他 Profile 使用各自的 Hermes Profile 和不同的 `HERMES_PROFILE`，但仍共享同一个 `DATA_DIR`。将 `<profile>` 替换为实际 Profile ID：

```bash
hermes -p "<profile>" mcp add life-assistant \
  --command node \
  --env DATA_DIR="$DATA_DIR" HERMES_PROFILE="<profile>" \
  --args "$LIFE_ASSISTANT_DIR/dist/index.js"
```

需要让 MCP 查询进程读取天气/油价 Key、预置位置或 `PROFILE_PUSH_ROUTES_JSON` 时，把对应 `KEY=value` 一并放在 `--env` 后、`--args` 前。不要省略 Profile 身份，也不要让不同 Profile 指向不同的数据目录。

验证和调整工具选择：

```bash
hermes mcp list
hermes mcp test life-assistant
hermes mcp configure life-assistant

hermes -p "<profile>" mcp list
hermes -p "<profile>" mcp test life-assistant
```

Hermes 中的工具名形如 `mcp_life_assistant_weather_current`，即 MCP 工具名中的点号会转换为下划线。

### 安装 Skill

Hermes 的 Profile skill store 相互隔离，每个需要 Life Assistant 的 Profile 都必须单独安装或同步一份。下面的 `LIFE_ASSISTANT_PROFILE_HOME` 只是 shell 辅助变量：标准 default Profile 通常是 `$HOME/.hermes`，其他 Profile 通常是 `$HOME/.hermes/profiles/<profile>`：

```bash
LIFE_ASSISTANT_PROFILE_HOME=/absolute/path/to/current/hermes-profile
install -D -m 0644 "$LIFE_ASSISTANT_DIR/skill/SKILL.md" \
  "$LIFE_ASSISTANT_PROFILE_HOME/skills/life-assistant/SKILL.md"
test -f "$LIFE_ASSISTANT_PROFILE_HOME/skills/life-assistant/SKILL.md"
hermes skills list --source local
```

安装到额外 Profile 时，将 `<profile>` 替换为实际 Profile ID：

```bash
LIFE_ASSISTANT_PROFILE_HOME="$HOME/.hermes/profiles/<profile>"
install -D -m 0644 "$LIFE_ASSISTANT_DIR/skill/SKILL.md" \
  "$LIFE_ASSISTANT_PROFILE_HOME/skills/life-assistant/SKILL.md"
hermes -p "<profile>" skills list --source local
```

Skill 安装后，Agent 会执行首次位置确认和每次会话的 `notify.pull` 兜底规则。

## 配置主动 Webhook

主动推送需要为每个 Profile 创建一条 Hermes 动态订阅。每条 route 只投递到一个平台，并使用自己的 64 位随机十六进制 HMAC secret。

创建 subscription 前，先在目标 Profile 中通过 Gateway setup 启用并配置 Hermes Webhook platform 以及计划用于 `--deliver` 的消息平台，再显式保存监听端口。本节命令中的 `<profile>` 替换为实际 Profile ID；default Profile 可省略 `-p "<profile>"`：

```bash
hermes -p "<profile>" gateway setup
hermes -p "<profile>" config set platforms.webhook.extra.port <gateway-port>
```

同时运行的 Profile Gateway 必须使用不同的 `<gateway-port>`。全新 Profile 应使用 `hermes -p "<profile>" gateway install --start-now` 安装并启动 Gateway，或通过选定的现有服务/容器管理器启动；若 Gateway 已在运行，请通过其正常的服务或进程管理器重启，使静态端口变更生效。`gateway run` 只是可选的前台运行方式。完成启动或重启后再验证：

```bash
hermes -p "<profile>" config get platforms.webhook.enabled
hermes -p "<profile>" config get platforms.webhook.extra.port
hermes -p "<profile>" gateway status --deep
```

两个 `config get` 输出应分别显示 Webhook 已启用和显式设置的 `<gateway-port>`，status 应确认该 Profile 的 Gateway 正在运行。这些命令不读取或输出 Webhook secret。

1. 生成并安全保存 secret，例如 `openssl rand -hex 32`。不要把真实值写入聊天、Git、命令历史或普通日志。
2. 在每个 Profile 的 Hermes Gateway 上创建同名 `deliver-only` route。prompt 必须为 `{notification.title}\n\n{notification.body}`。
3. 把该 route 的 loopback URL、route 名和同一 secret 写入 `PROFILE_PUSH_ROUTES_JSON`。
4. 让 scheduler 和对应 MCP 进程读取一致的 route 配置。

以下命令中的平台和变量只是配置形状；secret 变量应从权限受限的文件或环境安全加载：

```bash
hermes -p "<profile>" webhook subscribe "life-assistant-<profile>" \
  --prompt $'{notification.title}\n\n{notification.body}' \
  --deliver qqbot \
  --secret "$PROFILE_ROUTE_SECRET" \
  --deliver-only
```

Hermes route URL 必须使用上面显式保存的同一个 `<gateway-port>`，形如 `http://127.0.0.1:<gateway-port>/webhooks/<route-name>`。Life Assistant 只接受 loopback HTTP(S) URL。对应的配置形状如下，值均为占位符：

```json
{
  "<profile>": {
    "route": "life-assistant-<profile>",
    "url": "http://127.0.0.1:<gateway-port>/webhooks/life-assistant-<profile>",
    "secret": "<64-hex-secret>"
  }
}
```

`renderTarget` 是每个 Profile 条目的可选字段，指定该 Profile 主动通知的平台渲染目标：`"plain"`（纯文本，缺省兜底）、`"qq-markdown"`、`"feishu-markdown"`、`"wechat-markdown"`。缺省或未知值一律按 `"plain"` 处理。详见下文「平台渲染」。

替换占位符、压缩成单行后写入 `.env`。整个 JSON 值必须用单引号包裹，才能同时被 `source .env` 和 systemd `EnvironmentFile` 正确读取：

```bash
PROFILE_PUSH_ROUTES_JSON='{"<profile>":{"route":"life-assistant-<profile>","url":"http://127.0.0.1:<gateway-port>/webhooks/life-assistant-<profile>","secret":"<64-hex-secret>"}}'
```

route 名、URL、secret 必须与 Hermes subscription 一致；一个 Profile 当前只支持一个目标平台。每增加一个 Profile，就在同一个 JSON 对象中增加一个条目。

用以下命令检查订阅，然后创建一条临时日程做端到端验证：

```bash
hermes -p "<profile>" webhook list
```

## 启动唯一 scheduler

查询工具不依赖 scheduler，但主动天气预警、油价通知、每日生活简报、日程扫描和 outbox 投递都依赖它。前台验证可运行：

```bash
set -a
source .env
set +a
npm run start:scheduler
```

生产环境推荐由 systemd 托管。先确认 Node >= 22.13（`node:sqlite` 免 flag 的最低版本），并取得实际 Node 可执行文件的绝对路径：

```bash
node --version
node -p "process.execPath"
```

将 unit 保存为 `/etc/systemd/system/life-assistant-scheduler.service`，并把 `ExecStart` 中的 Node 占位符替换为上一步输出。未过期的 SQLite singleton lease 会让新 scheduler 成功早退，因此 unit 必须继续重试，直到 lease 过期后能够接管：

```ini
[Unit]
Description=Life Assistant scheduler
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<service-user>
WorkingDirectory=/absolute/path/to/life-assistant
EnvironmentFile=/absolute/path/to/life-assistant/.env
ExecStart=/absolute/path/to/node /absolute/path/to/life-assistant/dist/scheduler.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

保存或修改 unit 后加载、启动并验证：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now life-assistant-scheduler.service
systemctl is-active life-assistant-scheduler.service
systemctl status --no-pager life-assistant-scheduler.service
```

确保 `.env` 中的 `DATA_DIR` 为绝对路径，且与所有 MCP 注册一致。同一 `DATA_DIR` 不要启动第二个 scheduler；SQLite 租约是故障防护，不是多实例部署模式。

## 配置项

| 变量 | 用途 |
|---|---|
| `DATA_DIR` | SQLite/WAL 和旧 `store.json` 迁移源；生产必须使用绝对路径 |
| `HERMES_PROFILE` | MCP 进程的 Profile 身份；必填且不得静默回退 |
| `PROFILE_PUSH_ROUTES_JSON` | Profile 到 Hermes route、loopback URL、HMAC secret 的映射 |
| `LIFE_ASSISTANT_TIMEZONE` | scheduler 使用的 IANA 时区 |
| `DAILY_WEATHER_BRIEF_CRON` | 每日生活简报 cron，默认 `0 7 * * *` |
| `LOCATION_CITY/LAT/LON` | 可选预置共享位置；未设置时由 Agent 首次确认 |
| `QWEATHER_KEY` | 可选，和风天气实时/预报/官方预警和 GeoAPI |
| `QWEATHER_API_HOST` | 可选，和风天气 API host |
| `TIANAPI_KEY` | 可选，油价首选数据源 |
| `JUHE_KEY` | 可选，油价兜底数据源 |

旧 `NOTIFY_WEBHOOK_URL`、`BARK_URL`、`SERVERCHAN_SENDKEY` 已是迁移期 no-op，不要在新部署中配置。

## 07:00 确定性生活简报

`weather.daily_brief` 的默认时间是配置时区每天 07:00，可分别通过 `DAILY_WEATHER_BRIEF_CRON` 和 `LIFE_ASSISTANT_TIMEZONE` 调整。内容由当前天气、当日预报以及可用时的油价确定性生成，不调用 LLM；单个天气源失败时使用另一个结果继续，油价不可用时省略。

迁移旧部署时，如果 Hermes 中仍存在外部 LLM 天气 cron，应先端到端验证内置简报，再暂停或删除旧任务；验证期间两者并存会产生重复通知。

## 平台切换

目标平台属于 Hermes 动态订阅，不属于 Life Assistant 的 SQLite 数据模型。保持 route 名、URL 和 HMAC secret 不变，删除并用相同配置重建 subscription，只修改 `--deliver`：

```bash
hermes -p "<profile>" webhook remove "<route-name>"
hermes -p "<profile>" webhook subscribe "<route-name>" \
  --prompt $'{notification.title}\n\n{notification.body}' \
  --deliver weixin \
  --secret "$PROFILE_ROUTE_SECRET" \
  --deliver-only
```

这种切换通常无需修改 `PROFILE_PUSH_ROUTES_JSON`、SQLite 或 scheduler，也无需重启 Gateway。只有平台凭据或静态平台配置变化时才可能需要重启对应 Gateway；route 名、URL 或 secret 变化时，必须同步更新 `PROFILE_PUSH_ROUTES_JSON` 并重启 scheduler。

## 平台渲染

每个 Profile 可通过 `PROFILE_PUSH_ROUTES_JSON` 条目中的可选字段 `renderTarget` 指定主动通知的平台渲染目标，取值为 `"plain"`（纯文本，缺省兜底）、`"qq-markdown"`、`"feishu-markdown"`、`"wechat-markdown"`；缺省或未知值一律按 `"plain"` 处理。

```json
{
  "<profile>": {
    "route": "life-assistant-<profile>",
    "url": "http://127.0.0.1:<gateway-port>/webhooks/life-assistant-<profile>",
    "secret": "<64-hex-secret>",
    "renderTarget": "qq-markdown"
  }
}
```

- 四种目标都从同一份 `RenderBlock[]` 中间表示投影：QQ / 飞书 / 微信共用同一套保守 markdown 规则，plain 是缺省与兜底。markdown 快照 title 为 `# <headline>`，body 为 `**标签**：值`、块间 `\n\n` 分段的 markdown 块。
- 通知快照在生成时按该 Profile 的 `renderTarget` 渲染并落库，之后不重渲染；因此 `renderTarget` 只影响配置变更之后新生成的通知，已落库的旧快照不会自动升级为 markdown。
- 平台 markdown 分支任何渲染异常都回退 plain 兜底，不会导致通知发送失败。

## 工具一览

`location.get` · `location.set` · `location.detect` · `weather.current` · `weather.forecast` · `weather.alerts` · `oilprice.current` · `oilprice.next_adjustment` · `schedule.create` · `schedule.list` · `schedule.get` · `schedule.update` · `schedule.complete` · `schedule.delete` · `notify.pull`

日程工具不接受 `profileId`，而是绑定启动 MCP 时显式注入的 `HERMES_PROFILE`。农历生日或纪念日使用 `calendar: "lunar"`、`lunarMonth`、`lunarDay`；`leapMonthPolicy: "leap"` 仅在对应闰月年份触发。

## 如何新增定时推送

选择与需求匹配的层级：

1. 静态或重复的个人提醒：使用现有 `schedule.*`，数据和通知属于当前 Profile。
2. 需要实时天气、油价或其他外部数据的固定任务：实现 `AssistantModule` job，在指定 timezone 下运行，并通过 `ctx.notify` 发布。公共 job 会按配置 Profile fan-out；私有事件必须显式使用 Profile 发布路径。
3. 通用自然语言动态信息推送：当前尚未实现。规划中的 automation 将使用 SQLite 配置、白名单 action，并由 scheduler 在无需 LLM 的情况下执行。不要把它当作现有能力。

模块、job、Provider 和通知作用域的贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 当前状态与计划

已完成：SQLite 存储与旧数据迁移、Profile 私有日程、Profile notification/outbox、统一 Hermes HMAC V2 Webhook、`notify.pull` fallback、确定性生活简报、scheduler 单实例租约。

计划中：

- 动态信息推送 automation：SQLite 配置、白名单 action、scheduler 无 LLM 执行。
- 静默时段、snooze 和更完整的通知管理。
- 多位置支持与配置界面。

## 归档能力

快递追踪模块已封存且未在 `src/modules/index.ts` 注册，不属于当前工具或正常配置。恢复前应重新评估数据源、额度、隐私和测试覆盖。

## License

[MIT](LICENSE)
