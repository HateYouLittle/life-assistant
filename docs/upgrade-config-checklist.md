# Life Assistant 升级配置检查清单

> 适用场景：另一台机器上的旧版本 Life Assistant 升级到当前 `main`（含全量审阅修复后的版本）。
> 本清单只检查配置与运行环境，不包含业务代码变更说明；命令均不打印 secret。

## 1. 为什么需要这份清单

2026-08-15 真实环境 smoke 中发现旧 `.env` 存在两类配置问题：

1. `PROFILE_PUSH_ROUTES_JSON` 使用了裸 JSON（无外层单引号）。`source .env` 时 bash 会做
   quote removal，进程最终拿到的是非法对象字面量，解析出 **0 条 route**。
2. 条目中的 `route` 写成了 `qqbot`，而 Hermes 实际 subscription 名是
   `life-assistant-reminder-<profile>`；即使 JSON 合法也会被 `parseProfilePushRoutes`
   过滤掉。

结论：**升级代码本身不强制改配置**。只要旧配置已经是“单引号包裹的合法 JSON 且与
Hermes subscription 一致”，升级后重启即可。若配置来自同一套旧模板，则必须按本清单修正。

## 2. 升级前准备

```bash
cd /path/to/life-assistant
git fetch origin
git checkout main
git pull --ff-only origin main

# 备份 .env（备份文件已被 .gitignore 忽略）
cp .env ".env.bak-$(date +%Y%m%d%H%M%S)"
chmod 600 .env.bak-*

npm install
npm run build
npm test
```

基线应为：`npm test` 全绿（用例数随版本递增，以零失败为准），`npm run build` 零错误。

## 3. 必检项

| # | 检查项 | 要求 | 不满足时的影响 |
|---|---|---|---|
| 1 | Node.js | `node --version` ≥ 22.13（`node:sqlite` 免 flag 最低版本） | 启动失败 |
| 2 | `DATA_DIR` | 必须是绝对路径；所有 MCP 进程与唯一 scheduler 必须同一值 | 多进程读写不同 DB，通知/日程隔离失效 |
| 3 | `HERMES_PROFILE` | 每个 MCP 进程显式注入，不得为空，不得静默回退 default | MCP 拒绝启动或日程归属错误 |
| 4 | `PROFILE_PUSH_ROUTES_JSON` 格式 | 整个值是**合法 JSON**，且 `.env` 中用**单引号**包裹 | 解析出 0 条 route，主动推送全部失效 |
| 5 | route 名 | 与 `hermes -p <profile> webhook list` 显示的 subscription 名完全一致 | route 被过滤或 drift 判定错误 |
| 6 | route URL | `http://127.0.0.1:<gateway-port>/webhooks/<route-name>`，端口/路径与 Hermes 一致 | 投递到错误端口/路径 |
| 7 | secret | 每 Profile 独立 64 位十六进制；与创建 Hermes subscription 时相同 | 签名校验失败或配置被拒绝 |
| 8 | `renderTarget` | 缺省或 `plain` / `qq-markdown` / `feishu-markdown` / `wechat-markdown` | 非目标平台渲染 |
| 9 | `LIFE_ASSISTANT_TIMEZONE` | 合法 IANA 时区；注意它同时是 scheduler 简报/预警时区和 schedule 默认时区 | 简报/日程时间错误 |
| 10 | cron 配置 | `DAILY_WEATHER_BRIEF_CRON`、`HOLIDAY_REFRESH_CRON` 为合法 cron；`AUTOMATION_SCAN_CRON`（v0.3 新增，默认 `*/10 * * * *`）可按需覆盖 | scheduler 注册 job 时抛错 / automation 扫描周期不合预期 |
| 11 | Gateway | 目标 Profile Gateway 正在运行，且 `platforms.webhook.extra.port` 已显式保存 | Webhook 连接被拒 |
| 12 | 可选 Provider Key | `QWEATHER_KEY`、`TIANAPI_KEY`、`JUHE_KEY` 按需要配置，值不得提交 Git | 对应查询降级/失败 |

## 4. 配置验证命令（不打印 secret）

### 4.1 加载 .env 后验证 route 解析

```bash
cd /path/to/life-assistant
set -a
source .env
set +a

node --import tsx/esm --input-type=module - <<'EOF'
import { config } from './src/config.ts';
console.log('profiles:', Object.keys(config.profilePushRoutes));
for (const [profile, route] of Object.entries(config.profilePushRoutes)) {
  const url = new URL(route.url);
  console.log(JSON.stringify({
    profile,
    route: route.route,
    host: url.host,
    path: url.pathname,
    renderTarget: route.renderTarget ?? 'plain',
    secretHexLength: route.secret.length,
  }));
}
EOF
```

预期输出包含所有需要主动推送的 Profile，且 `secretHexLength` 为 64。
若输出 `PROFILE_PUSH_ROUTES_JSON is set but produced no valid routes` 或 profiles 为空，
按第 5 节修正。

### 4.2 核对 Hermes subscription

```bash
hermes -p "<profile>" webhook list
hermes -p "<profile>" config get platforms.webhook.enabled
hermes -p "<profile>" config get platforms.webhook.extra.port
hermes -p "<profile>" gateway status --deep
```

`webhook list` 中的 subscription 名、URL 端口/路径，必须与 `.env` 中该 Profile 条目的
`route` 和 `url` 一致；`gateway status` 应为 running。

### 4.3 验证 SQLite schema 与历史数据

```bash
set -a && source .env && set +a

node --import tsx/esm --input-type=module - <<'EOF'
import { getDatabase } from './src/core/database.ts';
const db = getDatabase();
console.log('schema version:', db.prepare("SELECT value FROM schema_meta WHERE key='version'").get());
console.log('schedules:', db.prepare('SELECT profile_id, COUNT(*) c FROM schedules GROUP BY profile_id').all());
console.log('deliveries:', db.prepare('SELECT status, COUNT(*) c FROM profile_notification_deliveries GROUP BY status').all());
EOF
```

- `schema version` 应为 `7`（v6 起：`profile_notifications` 增加可空的 `envelope` 列，用于日程提醒投递时重渲染相对时间；v7 起：`schedules` 增加可空的 `reminder_interval_minutes`/`reminder_max_attempts` 列，用于待办强提醒重发）。
- 若旧库中有历史 `profile_notifications`/deliveries，升级会自动迁移，不应报外键错误。
- 若数据库版本 > 7，说明是未来版本库被旧程序打开，应立即停止并用对应新版本程序处理。

> **v0.3 起迁移语义变化**：v4→v5 迁移是单向的（旧代码打开 v5 库会直接拒绝启动）。回滚必须连库一起处理：停服务 → 还原升级前的 v4 备份 → 部署旧代码。见本仓库 `docs/v0.3-capabilities-acceptance.md` 第 5 节。

## 5. 正确的 `.env` 示例（占位符）

```bash
# 生产必须绝对路径
DATA_DIR=/absolute/path/to/life-assistant/data

# MCP 进程身份；也可由 hermes mcp add --env 注入
HERMES_PROFILE=default

# 单引号包裹的合法 JSON；route/URL 必须与 Hermes webhook list 完全一致
PROFILE_PUSH_ROUTES_JSON='{"default":{"route":"life-assistant-reminder-default","url":"http://127.0.0.1:<default-port>/webhooks/life-assistant-reminder-default","secret":"<64-hex-secret>","renderTarget":"qq-markdown"},"bestie":{"route":"life-assistant-reminder-bestie","url":"http://127.0.0.1:<bestie-port>/webhooks/life-assistant-reminder-bestie","secret":"<64-hex-secret>","renderTarget":"qq-markdown"}}'

LIFE_ASSISTANT_TIMEZONE=Asia/Shanghai
DAILY_WEATHER_BRIEF_CRON="0 7 * * *"
HOLIDAY_REFRESH_CRON="0 2 * * *"

LOCATION_CITY=
LOCATION_LAT=
LOCATION_LON=

QWEATHER_KEY=
# 新式 API Key 绑定专属 host（控制台「设置 → API Host」），必须改成自己的专属 host；
# 旧订阅 key 才用默认 devapi.qweather.com。配错 host 时全部 403 并静默降级 Open-Meteo。
QWEATHER_API_HOST=devapi.qweather.com
TIANAPI_KEY=
JUHE_KEY=
```

注意：

- 不要把 JSON 写成裸 JSON：`PROFILE_PUSH_ROUTES_JSON={"default":{...}}`。
- 不要把 route 名写成平台名（如 `qqbot`）；route 名是 Hermes subscription 名。
- secret 必须安全保存：`.env` 权限 600，不写入聊天、Git 或普通日志。
- `renderTarget` 变化后需重启 scheduler 与读取该配置的 MCP 进程。

## 6. 升级后 smoke 清单

按顺序执行，每步通过再进入下一步：

1. **加载配置**
   ```bash
   set -a && source .env && set +a
   ```
   执行 4.1，确认 routes 非空。

2. **启动唯一 scheduler**
   ```bash
   npm run build
   systemctl --user restart hermes-gateway.service   # 或各 Profile 的 gateway 服务
   npm run start:scheduler
   ```
   日志应出现 `holiday.refresh_calendar` 注册（v0.3 起共 6 个 job，含 `automation.scan`）、scheduler started；重复启动第二个
   scheduler 应以退出码 1 早退。

3. **节假日抓取**
   ```bash
   node --import tsx/esm --input-type=module - <<'EOF'
   import { refreshHolidayCalendar, yearStatus } from './src/modules/holiday/calendar.ts';
   const result = await refreshHolidayCalendar();
   console.log(JSON.stringify({ fetched: result.fetched, skipped: result.skipped }));
   console.log('current year ready:', yearStatus(new Date().getFullYear())?.ready);
   EOF
   ```
   预期：当年 `fetched` 或已 ready，`skipped` 为空或仅下一年未发布，`ready=true`。

4. **workday 日程**
   ```bash
   node --import tsx/esm --input-type=module - <<'EOF'
   import { createSchedule, deleteSchedule } from './src/modules/schedule/service.ts';
   const item = createSchedule('<profile>', {
     title: '[SMOKE] workday schedule',
     calendar: 'solar',
     date: '<最近工作日 YYYY-MM-DD>',
     time: '09:00',
     timezone: 'Asia/Shanghai',
     recurrence: { frequency: 'workday' },
   });
   console.log({ id: item.id, status: item.status, enabled: item.enabled, nextRunAt: item.nextRunAt });
   deleteSchedule('<profile>', item.id);
   EOF
   ```
   预期：`status=active`、`enabled=true`、`nextRunAt` 为下一法定工作日 09:00 CST。

5. **Webhook 投递**
   - 确认目标 Profile Gateway running；
   - 创建一条临时通知或临时日程并让 scheduler 发布；
   - 查询 SQLite 确认 delivery 为 `sent` 且 read 已写入：
     ```sql
     SELECT d.status, d.attempts, d.sent_at, d.last_error
     FROM profile_notification_deliveries d
     JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
     WHERE n.dedupe_key = '<smoke-dedupe-key>';
     ```
   - 预期：`status='sent'`，`last_error` 为空；`notify.pull` 不再返回该通知。

6. **清理**
   - 删除 smoke 日程与 smoke 通知行；
   - 若 smoke 前 Gateway 为停止状态，完成后恢复停止。

## 7. 常见告警与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `PROFILE_PUSH_ROUTES_JSON is set but produced no valid routes` | JSON 非法、secret 非 64 hex、URL 非 loopback、route 名/Profile 名非法 | 按第 5 节修正 |
| `notify.pull` 没有公共天气/油价通知 | 公共事件只为配置了 route 的 Profile materialize | 确认该 Profile 在 `PROFILE_PUSH_ROUTES_JSON` 中有合法条目 |
| delivery 一直 `failed`/`fallback` | Gateway 未运行、端口错误、route 名不匹配、secret 不一致 | 执行 4.2 逐项核对 |
| `database schema version X is newer than supported version 6` | 新库被旧程序打开 | 停止旧进程，使用当前版本 |
| `HERMES_PROFILE is required...` | MCP 进程未注入 Profile 身份 | 在 `hermes mcp add --env` 或 `.env` 中显式设置 |
| workday/holiday 日程创建后 `enabled=0` | 当年节假日数据未 ready | 先执行第 6 节第 3 步，或调用 `holiday.refresh` |

## 8. 回滚

```bash
cd /path/to/life-assistant
cp .env.bak-<timestamp> .env
chmod 600 .env
git checkout <升级前提交哈希>
npm install
npm run build
```

**v0.3 之前（schema ≤ 4）**：SQLite 使用 additive 迁移，回滚代码通常可继续读取旧数据；
若已写入新表数据，旧版本会忽略对应表，不影响既有日程/通知。

**v0.3（schema 5）**：v4→v5 迁移单向，旧代码打开 v5 库会被拒绝启动。若库已升级到
v5，回滚必须：停服务 → 从升级前备份还原 v4 库 → 部署旧代码 → 确认 `version == 4`。

**当前（schema 6）**：v5→v6 仅给 `profile_notifications` 表尾追加可空的 `envelope` 列，
无数据改写；旧代码无法打开 v6 库（版本护栏拒绝），回滚需还原 v5 备份或手工把
`schema_meta.version` 改回 5 并删除 `envelope` 列。

## 9. 验收签字

- [ ] 4.1 route 解析输出包含全部目标 Profile
- [ ] 4.2 Hermes subscription 与 `.env` 逐字段一致
- [ ] 4.3 schema version=6、旧数据可读
- [ ] 6.3 节假日 ready
- [ ] 6.4 workday 日程 nextRunAt 正确
- [ ] 6.5 Webhook delivery=sent、pull 不重复返回
- [ ] 6.6 smoke 数据已清理
- [ ] `npm test` 全部通过、`npm run build` 零错误
