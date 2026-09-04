# Life Assistant - Hermes 个人生活助理

Life Assistant 是面向 Hermes Agent 的 Skill + MCP 服务，提供天气、空气质量、生活指数、油价、Profile 私有日程、自动任务、个人/共享记账，并通过可靠 outbox 将主动通知交给 Hermes Gateway 投递。

| 能力 | 当前行为 |
|---|---|
| 天气 | 实时天气、7 日预报、气象预警、生活指数（穿衣/紫外线/洗车等）、确定性每日生活简报 |
| 空气质量 | 实时 AQI、等级与污染物浓度；和风国标优先，Open-Meteo 美标兜底；每日简报 best-effort 并入空气行 |
| 油价 | 当前 92#/95#/0# 油价、下一次调价窗口与提前通知 |
| 日程 | 待办、生日、纪念日；支持公历、中国农历、重复提醒和法定节假日/工作日频率 |
| 节假日 | 中国大陆法定节假日与调休上班日历法；scheduler 每年自动获取下一年安排；放假倒计时查询 |
| 自动任务 | Profile 私有 automation：白名单 action（天气/预报/空气/油价）+ 条件 DSL，scheduler 无 LLM 执行 |
| 记账 | 个人账本（账户/收支/转账/汇总）与共享账本（成员共享公共账户、记账互相通知、每月 1 号月度账单） |
| 通知 | Profile SQLite outbox、Hermes HMAC V2 `deliver-only` Webhook、`notify.pull` 失败兜底；静默时段、snooze、取消与通知列表 |
| 备份 | `assistant.export` / `assistant.import`：日程、自动任务、静默时段与位置的 JSON 快照，按 ID 幂等导入 |

当前共注册 46 个 MCP 工具。快递追踪已经封存，未注册到运行时。

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
- `src/scheduler.ts` 是唯一常驻调度器：执行模块 cron、每分钟调用注册了 `tick` 的模块（如 schedule 到期扫描）、排空 outbox 投递；核心不 import 任何模块内部文件。
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

Hermes route URL 必须使用上面显式保存的同一个 `<gateway-port>`，形如 `http://127.0.0.1:<gateway-port>/webhooks/<route-name>`。Life Assistant 只接受主机名为 `127.0.0.1` 或 `[::1]` 的 HTTP(S) URL（`localhost` 等其他 loopback 写法会被拒绝）。对应的配置形状如下，值均为占位符：

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

将 unit 保存为 `/etc/systemd/system/life-assistant-scheduler.service`，并把 `ExecStart` 中的 Node 占位符替换为上一步输出。未过期的 SQLite singleton lease 会让新 scheduler 以退出码 1 早退（systemd 将其视为失败并按 `Restart=always` 继续重试），直到 lease 过期后能够接管：

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

## Web 仪表盘与只读 REST API

Life Assistant 内置一个只读 Web 仪表盘：浏览器直接展示天气、空气质量、生活指数、油价、节假日/调休、日程、记账、自动化规则与系统健康，后端通过轻量只读 REST API 复用项目全部领域模块，不写库、不影响 scheduler 与 MCP。

- **后端**：`src/server/`，基于 [Hono](https://hono.dev) 与 `@hono/node-server`，单端口同时托管 API 与前端静态产物（`@hono/node-server/serve-static` 提供 `dist/web`）。
- **前端**：`web/`，Vite + React 19 + TypeScript + Tailwind CSS + Lucide Icons + `lunar-javascript`，暗黑 Bento Grid 布局，自适应明暗主题、骨架屏与响应式网格。
- **端口**：默认 `3080`，由环境变量 `PORT` 覆盖。
- **Profile 切换**：通过 `?profile=<id>` 查询参数或页头切换器；未指定时回落到 `HERMES_PROFILE`，再回落 `default`。

### API 端点（全部只读 Get）

| 端点 | 说明 |
|---|---|
| `/api/health` | 服务健康与当前 profile |
| `/api/overview` | 聚合概览（位置、日历、天气、油价、日程计数、记账汇总、静默时段） |
| `/api/weather` | 天气、7 日预报、AQI、官方预警、生活指数 |
| `/api/oilprice` | 当前油价与下一次调价窗口 |
| `/api/holiday` | 今日工作日/节假日、下一个法定节假日、全年安排与调休 |
| `/api/schedules` | 日程与提醒（可按 `status`、`type` 过滤） |
| `/api/bookkeeping` | 账户余额、月度收支汇总、最近流水、账本列表 |
| `/api/automations` | 自动化规则与最近运行结果 |

所有端点支持可选 `?profile=<id>`。天气/油价端点会实际请求上游（和风/Open-Meteo/TianAPI），其余端点读取本地 SQLite。

### 运行（前台调试）

```bash
set -a
source .env
set +a
npm run dev:web        # tsx 热重载
npm run start:web      # 生产模式，读取 dist/web 静态资源
```

### systemd 常驻服务

生产环境建议由 systemd 托管，与 scheduler 同等运维标准。先取得 Node 绝对路径并替换下方占位符，保存为 `/etc/systemd/system/life-assistant-web.service`：

```ini
[Unit]
Description=Life Assistant Web - responsive dashboard and read-only REST API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<service-user>
WorkingDirectory=/absolute/path/to/life-assistant
EnvironmentFile=/absolute/path/to/life-assistant/.env
Environment=DATA_DIR=/absolute/path/to/life-assistant/data
Environment=PORT=3080
ExecStart=/absolute/path/to/node /absolute/path/to/life-assistant/dist/server/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

加载、启动并验证：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now life-assistant-web.service
systemctl is-active life-assistant-web.service
curl -s http://127.0.0.1:3080/api/health
```

前端/后端构建已并入根 `npm run build`（先 `tsc` 编译 Node，再 `vite build` 产出 `dist/web`），`dist/web` 与 `dist/server` 同属一端口拓扑，无需额外 Nginx 或反向代理。

| 变量 | 用途 |
|---|---|
| `DATA_DIR` | SQLite/WAL 和旧 `store.json` 迁移源；生产必须使用绝对路径 |
| `HERMES_PROFILE` | MCP 进程的 Profile 身份；必填且不得静默回退 |
| `PROFILE_PUSH_ROUTES_JSON` | Profile 到 Hermes route、loopback URL、HMAC secret 的映射 |
| `PROFILE_DISPLAY_NAMES` | 可选，Profile 显示名映射（JSON，如 `{"default":"我","bestie":"对象"}`）；共享账本通知的「记录人」用友好名替代 profile id，非法 JSON/非字符串值丢弃该字段并回落 profile id |
| `LIFE_ASSISTANT_TIMEZONE` | scheduler 简报/预警渲染时区，以及 schedule 创建/更新时未显式指定 timezone 的默认时区。**生产部署必须显式设置（IANA 名称，如 `Asia/Shanghai`）**：否则日报/去重按机器本地时区计算，跨时区部署会出现「今日」语义错位 |
| `DAILY_WEATHER_BRIEF_CRON` | 每日生活简报 cron，默认 `0 7 * * *` |
| `HOLIDAY_REFRESH_CRON` | 节假日安排每日刷新 cron（Asia/Shanghai），默认 `0 2 * * *` |
| `AUTOMATION_SCAN_CRON` | 自动任务扫描 cron，默认 `*/10 * * * *`；单任务调度在其 schedule 中定义 |
| `BOOKKEEPING_REPORT_CRON` | 记账月度账单 cron，默认 `0 9 1 * *`（每月 1 号 09:00 推送上月收支汇总） |
| `WEATHER_ALERTS_CRON` | 天气预警扫描 cron，默认 `*/15 * * * *` |
| `OIL_WATCH_CRON` | 油价调价 watch cron，默认 `0 9 * * *` |
| `LOCATION_CITY/LAT/LON` | 可选预置共享位置；未设置时由 Agent 首次确认 |
| `QWEATHER_KEY` | 可选，和风天气实时/预报/官方预警和 GeoAPI |
| `QWEATHER_API_HOST` | 可选，和风天气 API host；**新式 API Key 绑定专属 host（如 `xxx.re.qweatherapi.com`），必须配置，否则全部 403 Invalid Host 静默降级 Open-Meteo（官方预警也不可用）**；旧订阅 key 保持默认 `devapi.qweather.com` |
| `TIANAPI_KEY` | 可选，油价首选数据源 |
| `JUHE_KEY` | 可选，油价兜底数据源 |

天气预警扫描与油价调价 watch 的默认 cron 可分别通过 `WEATHER_ALERTS_CRON`、`OIL_WATCH_CRON` 覆盖。

旧 `NOTIFY_WEBHOOK_URL`、`BARK_URL`、`SERVERCHAN_SENDKEY` 已是迁移期 no-op，不要在新部署中配置。

## 07:00 确定性生活简报

`weather.daily_brief` 的默认时间是配置时区每天 07:00，可分别通过 `DAILY_WEATHER_BRIEF_CRON` 和 `LIFE_ASSISTANT_TIMEZONE` 调整。内容仅由当前天气、当日预报与空气质量（best-effort，单源失败时省略空气行）确定性生成，不包含油价，也不调用 LLM；单个天气源失败时使用另一个结果继续，两个天气源都不可用时本轮不发送。

迁移旧部署时，如果 Hermes 中仍存在外部 LLM 天气 cron，应先端到端验证内置简报，再暂停或删除旧任务；验证期间两者并存会产生重复通知。

## 静默时段与通知管理

每个 Profile 可用 `notify.quiet_hours` 设置静默时段（如 `22:00–07:00`，支持跨午夜和自定义时区）。窗口内 scheduler 不尝试主动投递，已排队的 delivery 保持 pending，窗口结束后自动补投；`notify.pull` 是用户主动拉取，不受静默时段影响。

配套管理工具：

- `notify.list`：查看最近通知与各 route 投递状态（sent/pending/failed/fallback/cancelled），用于排查「为什么没收到」；
- `notify.snooze`：把未成功投递的通知推迟 1–1440 分钟再投递；幂等窗口内的不确定失败会被拒绝，避免重复推送；
- `notify.cancel`：取消未投递通知的后续投递，取消后 `notify.pull` 也不再复述；只取消单条通知，**不会停止强提醒重发**（停止重发请用 `schedule.complete` / `schedule.delete` / `schedule.update(clearStrongReminder: true)`）。

## 自动任务 automation

`automation.*` 提供 Profile 私有、确定性执行的动态任务（原 planned automation 已落地）：

- **白名单 action**：`weather.current`、`weather.forecast`（days 1–7）、`airquality.current`、`oilprice.current`，全部复用模块 Provider，不调用 LLM；
- **条件 DSL**：`{ field, op, value }`，field 是 action 结果的 dot-path（如 `today.precipAmountMm`、`aqi`、`p92`；注意 `today.precipProb` 仅 Open-Meteo 数据源有值，和风路径用 `precipAmountMm`），支持 `> >= < <= == !=`；字段缺失视为不满足；缺省条件表示到点必提醒；
- **调度**：`daily`（每天 HH:mm，可带 IANA 时区）或 `interval`（每 N 分钟，最小 5）；scheduler 按 `AUTOMATION_SCAN_CRON`（默认每 10 分钟）扫描到期任务，interval 任务实际执行最长延迟一个扫描周期（默认 10 分钟）；
- **投递**：条件满足时走 Profile 私有通知通道（静默时段、outbox、`notify.pull` 兜底全部适用）；dedupe key 含任务本地日期，同一任务每个本地日期最多主动提醒一次；daily 任务当日执行失败不影响当日后续重试（失败不记为当日已完成，下次扫描仍会尝试），成功一次后当日不再重复执行；interval 任务失败则等待下一轮扫描；
- **工具**：`automation.create / list / update / delete / run`；`run` 立即手动执行一次用于验证配置，不影响既定调度节奏；单任务失败只记录 `last_error`，不阻断其它任务。

## 备份与迁移

`assistant.export` 导出当前 Profile 的 JSON 快照（日程全量含完成/归档状态与强提醒配置、自动任务、静默时段和共享位置），`assistant.import` 按 ID 幂等导入：已存在的条目跳过不覆盖，非法条目跳过并计数；共享位置仅在 `applyLocation: true` 时覆盖（位置是全 Profile 共享数据）。快照不含通知历史与 Webhook secret；当前导出格式 `EXPORT_VERSION=2`（v1 旧快照仍可导入，其中无强提醒字段，导入后强提醒视为未开启），超出支持范围的快照版本会显式拒绝；单类条目超过 1000 条时快照带 `truncated: true`（不完整，需分批处理）。

注意：`assistant.export` 与 `schedule.list`/`schedule.get` 是只读查询，但若存在 `next_run_at` 已损坏的日程行，读取时的自愈会将其停用并落库（一次写操作）。备份前无需处理，但纯备份场景下 WAL 可能因此增长。

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

这种切换通常无需修改 `PROFILE_PUSH_ROUTES_JSON`、SQLite 或 scheduler，也无需重启 Gateway。只有平台凭据或静态平台配置变化时才可能需要重启对应 Gateway；route 名、URL、secret 或 `renderTarget` 变化时，必须同步更新 `PROFILE_PUSH_ROUTES_JSON` 并重启 scheduler，以及读取该配置的 MCP 进程（`PROFILE_PUSH_ROUTES_JSON` 在进程启动时一次性解析并缓存）。

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
- `renderTarget` 或 `PROFILE_PUSH_ROUTES_JSON` 任一字段变化后，必须重启 scheduler 与读取该配置的 MCP 进程才会生效。
- 平台 markdown 分支任何渲染异常都回退 plain 兜底，不会导致通知发送失败。

## 中国大陆节假日与工作日

节假日数据是共享历法数据，所有 Profile 读同一份，用户无需也不能手动提供。scheduler 的 `holiday.refresh_calendar` job 每天（默认 02:00 Asia/Shanghai，可用 `HOLIDAY_REFRESH_CRON` 调整）确保当年安排可用；每年 10 月起还会自动获取下一年国务院放假安排，并在 scheduler 启动时引导补齐当年数据。次年数据只在主源携带国务院通知原文链接时才入库，避免任何数据源的预估值被当成权威安排。

数据源与兜底：

1. 主源 [holiday-cn](https://github.com/NateScarlet/holiday-cn)（jsDelivr CDN + raw.githubusercontent 镜像）；
2. 独立兜底 [chinese-days](https://github.com/vsme/chinese-days)（npm + jsDelivr）。

抓取结果经过结构校验后按数据集实际覆盖的日期范围原子入库，校验项包括：返回数据集年份与请求年份一致、日期是真实存在的规范日历日、按年份口径要求节日齐全（2008 年起七个法定节日，2004–2007 为元旦/春节/劳动节/国庆四节日）、休假日落在合法日期窗口、补班日必须是周末、休假日按节日连续、全年休假日总数 20–45。跨年元旦仅允许「上一年 12/20 之后的元旦日期」，并按日期自然年入库；`holiday.list`/`holiday.next` 会把 12/30–1/1 这类跨年日期合并显示为同一个连休期。校验失败保留旧数据。无官方数据的年份被视为「无数据区间」：workday/holiday 日程在该区间不触发，也绝不按普通周历猜测。

日程 recurrence 新增两个频率（仅公历 + `Asia/Shanghai` 时区）：

- `"workday"`：中国大陆法定工作日 = 周一至周五 − 法定节假日 + 调休上班的周末；
- `"holiday"`：仅法定节假日中的休假日（不包含普通周末）。

示例：`schedule.create` 传 `recurrence: "workday"`、`time: "09:00"` 即「每个法定工作日早上 9 点提醒」；春节假期自动跳过，调休补班的周六正常触发。新一年数据入库后，scheduler 会自动重算所有受影响的 workday/holiday 日程并恢复此前因无数据停用的日程；`until`/`count` 规则真正耗尽的日程会自动标记为 `completed`，仅因数据缺失而停用的日程保持 `active` 等待恢复。

查询工具：`holiday.next`（距离下次放假的天数、节日名、起止日期与调休上班日）、`holiday.list`（某年完整安排）、`holiday.is_workday`（判断某天是否法定工作日）、`holiday.refresh`（手动补抓某年，数据仍来自官方源；数据已就绪时仅确认不重抓，`force: true` 会重新抓取并按内容哈希幂等入库，用于上游数据更正后的主动重拉）。

待办强提醒：`schedule.create` 传 `intervalMinutes`（1–10080 分钟，默认 120）与/或 `maxAttempts`（1–99 轮，默认 3）即可开启；到期未确认完成时 scheduler 按间隔重复提醒，直至完成/删除/达上限；重发通知标题带轮次标记（如「（第 2 次提醒，共 3 次）」），与正式提醒可区分。强提醒需要一条 occurrence 正式提醒（`target: "occurrence"` 且 `minutesBefore: 0`，默认提醒即满足），否则创建/更新会被拒绝；`schedule.update` 传 `clearStrongReminder: true` 可随时关闭。注意 `intervalMinutes` 大于等于 recurrence 触发间隔（daily=1440 分钟、weekly=10080 分钟）时重发不生效，会被下一 occurrence 的正式提醒接管（创建/更新会输出可检测的警告；该间隔警告仅适用于未配 `byWeekday` 的 daily/weekly，配了 `byWeekday` 时实际触发间隔不定，无法廉价检测）。

## 油价调价窗口

调价窗口表按年度校准维护：已校准年份使用发改委正式调价日历。超出已校准年份时，系统按「每 10 个工作日」自动生成候选窗口，并在结果中标注「未校准」，请按发改委正式调价日历定期校准。

## 记账 bookkeeping

`bookkeeping.*` 提供个人账本与多成员共享账本：

- **个人账本**：每个 Profile 私有，首次使用记账工具时自动创建，含账户、收支、转账与月度汇总；
- **共享账本**：`ledger_create` 创建（创建者即 owner），`member_add`/`member_remove` 管理成员（owner 专属，不能移除 owner 本人）；`account_create(ledgerId)` 在账本下创建**共享账户**（如家庭公共资金池），余额全员共享可见，任意成员可记账；
- **流水**：`entry_add`/`entry_list`/`entry_get`/`entry_update`/`entry_delete`；金额单位是元（>0，最多两位小数，存储为分）；`transfer` 需要两个不同账户；修改/删除用 `version` 乐观锁，冲突后重新读取再重试。改/删权限：记录人本人，或共享账本 owner；
- **余额**：永不落库，由全部流水实时派生（含转账双边）。跨账本转账为**单流水**设计：流水记入共享账本后，对端账本成员通过 `shared_entry` 通知可见该笔变动（通知带对端账户/账本信息），但对端账本的流水列表/汇总**不包含**该条目；
- **通知**：共享账本内记账/修改/删除会通知除记录人外的每个成员；每月 1 号（`BOOKKEEPING_REPORT_CRON`，默认 09:00）scheduler 推送上月个人 + 各共享账本收支汇总，上月无流水的 Profile 静默跳过。月报是 1 号推送时刻的快照：之后补记的上月流水不会出现在任何月报；
- **汇总**：`summary` 返回指定月（`yyyy-LL`，按配置时区切自然月）的收入/支出/结余、分类聚合与账户余额清单（单位为元）；其中**账户余额为当前实时值，非所选月份月末快照**。

## 工具一览

`location.get` · `location.set` · `location.detect` · `weather.current` · `weather.forecast` · `weather.alerts` · `weather.indices` · `airquality.current` · `oilprice.current` · `oilprice.next_adjustment` · `schedule.create` · `schedule.list` · `schedule.get` · `schedule.update` · `schedule.complete` · `schedule.delete` · `holiday.next` · `holiday.list` · `holiday.is_workday` · `holiday.refresh` · `notify.pull` · `notify.list` · `notify.snooze` · `notify.cancel` · `notify.quiet_hours` · `automation.create` · `automation.list` · `automation.update` · `automation.delete` · `automation.run` · `bookkeeping.ledger_list` · `bookkeeping.ledger_create` · `bookkeeping.member_add` · `bookkeeping.member_remove` · `bookkeeping.account_create` · `bookkeeping.account_list` · `bookkeeping.account_update` · `bookkeeping.account_delete` · `bookkeeping.entry_add` · `bookkeeping.entry_list` · `bookkeeping.entry_get` · `bookkeeping.entry_update` · `bookkeeping.entry_delete` · `bookkeeping.summary` · `assistant.export` · `assistant.import`

日程工具不接受 `profileId`，而是绑定启动 MCP 时显式注入的 `HERMES_PROFILE`。农历生日或纪念日使用 `calendar: "lunar"`、`lunarMonth`、`lunarDay`；`leapMonthPolicy: "leap"` 仅在对应闰月年份触发。法定节假日/工作日频率使用 `recurrence.frequency: "workday"` 或 `"holiday"`，见上文。

## 如何新增定时推送

选择与需求匹配的层级：

1. 静态或重复的个人提醒：使用现有 `schedule.*`，数据和通知属于当前 Profile。
2. 需要实时天气、油价或其他外部数据的用户可配置任务：优先使用 `automation.*`（白名单 action + 条件 DSL，无需写代码）。白名单之外的实时数据需求：实现 `AssistantModule` job，在指定 timezone 下运行，并通过 `ctx.notify` 发布。公共 job 会按配置 Profile fan-out；私有事件必须显式使用 Profile 发布路径。需要每分钟颗粒度的扫描（而非 cron）时，实现模块的 `tick(at)` 扩展点（参考 `src/modules/schedule/tick.ts`）。
3. 新的白名单 action：在 `src/modules/automation/actions.ts` 注册（复用模块 Provider），即自动对全部 Profile 的 automation 开放。

新增一种通知类型时，payload 结构与 `RenderBlock[]` 渲染器写在模块自己的 `notification.ts` 里并经 `registerNotificationBlocks(kind, fn)` 自注册——核心层只提供信封骨架与 plain/markdown 投影，无需改动。

模块、job、Provider 和通知作用域的贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 当前状态与计划

已完成：SQLite 存储与旧数据迁移、Profile 私有日程、Profile notification/outbox、统一 Hermes HMAC V2 Webhook、`notify.pull` fallback、确定性生活简报（含空气质量行）、scheduler 单实例租约、中国大陆法定节假日/工作日历法（自动抓取 + workday/holiday 日程频率 + 放假倒计时查询）、静默时段与通知管理（list/snooze/cancel/quiet_hours）、动态自动任务 automation（白名单 action + 条件 DSL，无 LLM）、生活指数查询、个人/共享记账（共享账本成员通知与月度账单）、Profile 数据导出/导入。

计划中：

- 多位置支持与配置界面。
- 白名单 action 扩展（如限行、电价）与更丰富的条件组合（多条件 AND/OR）。

## 归档能力

快递追踪模块已封存且未在 `src/modules/index.ts` 注册，不属于当前工具或正常配置。恢复前应重新评估数据源、额度、隐私和测试覆盖。

## License

[MIT](LICENSE)
