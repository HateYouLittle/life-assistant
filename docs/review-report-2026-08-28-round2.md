# Life Assistant 全量审查报告 · 第二轮（2026-08-28）

> 审查对象：`main` @ `8e4e4a9`（第一轮报告 docs/review-report-2026-08-28.md 的两轮修复提交 `d1d99ad`、`8e4e4a9` 之后）。
> 覆盖范围：全部 52 个 src 文件（约 11.2k 行）逐行通读；文档全量（README / CONTRIBUTING / docs ×7 / skill / .env.example）；测试套件以运行验证 + 定向抽查为主（约 14.5k 行未逐行审）。
> 验证基线：`tsc --noEmit` 0 错误；`npm test` 534/534 通过；`npm audit` 2 个 moderate（node-cron→uuid，不可达路径，沿用第一轮结论）；`git status` / `git diff --check` 干净。

---

## 1. 总体结论

**本轮未发现 critical / HIGH 级新问题，项目处于可发布状态。**

第一轮报告的修复在 `d1d99ad`（52/55 项）与 `8e4e4a9`（收尾 5 项）中真实落地，本轮逐项回到源码验证：3 个 HIGH、10 个 MEDIUM 及 LOW 系列关键项全部确认修复，且均有对应回归测试锁定。第一轮的 L5（reads 表 FK）确认为误报——`profile_notifications` 主键本就是单列 `id`，单列 FK 正确，提交信息已如实标注。

## 2. 第一轮修复落地核验（全部确认）

- **H1** `notify.pull` 返回 `{ count, notifications }`（`src/core/notify-module.ts`），工具级测试锁定返回形状（`tests/notify-management.test.ts`）。
- **H2** snooze 重置幂等窗口并换代（`src/core/notify-manage.ts`），与 route 恢复入队同口径。
- **H3** 静态表耗尽后按「每 10 个工作日」续推候选窗口并带 `calibrated: false` 标记（`src/modules/oilprice/schedule.ts`）；advance 通知不再静默停用。
- **M1–M10**：跨账本转账口径（README 已写明单流水设计 + 通知带对端信息）、共享流水跨账本移出限 owner、>48h 延迟发布、previous ±1 分 + retry 告警、`next_adjustment` 容错、import 前 quietHours 预校验、fence 异常兜底 + 投递前租约复核（leaseCheck）、时区/绝对 DATA_DIR 启动校验、正则 lint 契约测试删除、期初流水补发成员通知——全部落地。
- **L 系列**关键项抽查落地（L1–L12、L14–L29、L34–L38）。
- **测试补强**：migrateLegacyJson 端到端、notify.pull 工具形状、markdown 回退、真实 automation action 冒烟、leaseCheck 门控等第一轮 §6 缺口均已补齐。

## 3. 本轮新发现（已全部处理，见 §5 修复日志）

### LOW-1 `holiday.refresh` 无法对已 ready 的年份强制重抓
`ensureHolidayYear` 开头 `if (ready) return ready`，而工具的 `force: true` 只把失败冷却置 0，不影响「已 ready 即跳过」。上游数据被更正后无法主动重拉；对 ready 年份调用 refresh 是无网络访问的空操作却报成功。
**位置**：`src/modules/holiday/calendar.ts`（ensureHolidayYear）配合 `src/modules/holiday/index.ts`（refresh 工具）。

### LOW-2 官方预警逐条发布未隔离
`runWeatherAlertsCheck` 的 inferred 分支对单条发布失败有 try/catch 隔离，但 official 分支只隔离了「构建」，`await publishNotification(notification, publishers)` 在 for 循环内无保护：一条预警发布抛错（如 SQLITE_BUSY）会中断本轮剩余预警。15 分钟后下轮自愈且 dedupe 防重复，影响有限。
**位置**：`src/modules/weather/index.ts`（runWeatherAlertsCheck）。

### LOW-3 `.env.example` 缺 `AUTOMATION_SCAN_CRON`
README 配置表和 upgrade-checklist 均记载该变量（默认 `*/10 * * * *`），`BOOKKEEPING_REPORT_CRON` 在 .env.example 有占位注释，唯独它缺失。

### LOW-4 assistant import 的 status 两步落库存在瞬态窗口
`importAssistantExport` 对日程先 create（active）再按快照 status 补一次 update；两步之间 scheduler tick 理论上可对即将标记 completed/archived 的日程发布窗口内补发提醒。原报告记为 INFO「可接受」；分析确认 `createSchedule` 的 normalizeInput 接受三种 status 且派生逻辑与 update 完全一致，可安全单步化。
**位置**：`src/modules/assistant/index.ts`。

### INFO 残留（上轮已记录，本轮一并清理或归档说明）
1. 死代码：`schedule/service.ts` 的 `reminderMinutes()`、`automation/actions.ts` 的 `listAutomationActionNames()`、`scheduler.ts:11` 的 `export { notifyModule }`（无消费方）。
2. 不可达分支：`notification-publisher.ts` 的 `resolveRenderTarget(...) ?? "plain"`（resolveRenderTarget 恒不返回 undefined）。
3. `lunar-javascript.d.ts` 全 any：成员访问绕过类型检查。
4. IP 探测走明文 HTTP（`location/index.ts`）：**本轮实测 `https://ip-api.com` 返回 403**——免费档仅提供 HTTP，HTTPS 为付费功能，第一轮「改 HTTPS 成本极低」的建议前提不成立。处置：保留 HTTP，代码内注明约束（结果仅为建议值、绝不自动落库；要消除明文查询应整体替换为支持 HTTPS 的探测源）。

## 4. 文档一致性核对（全部通过）

46 个 MCP 工具计数、schema version 8 及版本护栏、scheduler 注册日志「6 行 registered + started, 7 jobs」、HMAC V2 / 10s 超时 / 禁重定向 / 55 分钟幂等窗口 / 退避档位可达性、静默时段与 pull 不受限、强提醒默认 120/3 与 clearStrongReminder、记账金额 9e12 上限与两位小数、月度账单 joined_at 截断与 hasData 跳过、summary「余额为当前实时值」、renderTarget 四值与 plain 兜底、`.gitignore` 含 `.zcode/`、package 版本 0.3.0 单一来源——逐项与代码一致。

安全与数据完整性复核：全部 SQL 动态拼接点仅限经 sanitize 的 limit/offset/子句顺序；LIKE 通配符有 `escapeLike` + ESCAPE 转义；路由表 null-prototype、secret 熵值校验、URL 脱敏、automation 条件 DSL 原型链探针拒绝、记账分单位 + 乐观锁、outbox claim/fencing/幂等窗口语义完整。未发现密钥泄漏路径、未参数化 SQL 或跨 Profile 读写。

## 5. 修复日志（本归档随附的代码提交）

| 项 | 修复 | 测试 |
|---|---|---|
| LOW-1 | `ensureHolidayYear` 增加 `force` 选项：已 ready 也重新抓取（payload_hash 未变时入库层幂等），并跳过失败冷却；refresh 工具透传 `force`，工具描述与 README 同步 | `tests/holiday-calendar.test.ts`：force 重抓 ready 年份 + 未变 payload 幂等 + 变化 payload 替换 |
| LOW-2 | official 分支发布调用包 try/catch 逐条隔离（与 inferred 分支同口径），下一轮按 dedupe key 幂等重试 | `tests/profile-schedule.test.ts`：注入会抛错的 publish，断言第二条预警照常发布 |
| LOW-3 | `.env.example` 补 `AUTOMATION_SCAN_CRON` 注释占位 | — |
| LOW-4 | `importAssistantExport` 的 status 随 `createSchedule` 单步落库，删除先建后改的两步（同时移除不再使用的 `updateSchedule` 导入） | 既有 portability 往返用例（含 archived 状态保留）守护 |
| INFO-1 | 删除死代码：`reminderMinutes` / `listAutomationActionNames` / `scheduler.ts` 的 `notifyModule` 重导出（改为 side-effect import 并注明动机） | 全量套件回归 |
| INFO-2 | 删除 `resolveTargetForProfile` 尾部不可达 `?? "plain"` | 全量套件回归 |
| INFO-3 | `lunar-javascript.d.ts` 最小类型化（Lunar/LunarYear/LunarSolar 实际用到的成员） | `tsc --noEmit` 类型化生效 |
| INFO-4 | IP 探测保留 HTTP 并在代码内注明免费档 HTTPS 不可用（实测 403）与替换建议 | — |

**修复后基线**：`tsc --noEmit` 0 错误；`npm run build` 0 错误；`npm test` 536/536 通过；`git diff --check` 干净。

---

*本报告为只读审查产物；§5 所列代码修复随本文件一并提交。*
