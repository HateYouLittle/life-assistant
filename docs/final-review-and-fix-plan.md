# 全量审阅结果与修复跟踪（2026-08-15）

> 本文件是本次全量代码/文档审阅的唯一跟踪文档。修复完成一项，立即把状态改为
> `[x]` 并在「完成记录」中追加一行；全部完成后跑通验证命令并更新底部基线。

## 0. 审阅基线

| 验证项 | 结果 |
|---|---|
| `npm test` | 333 / 333 通过 |
| `npm run build` | 零错误 |
| `git diff --check` | 干净 |
| 测试覆盖率 | 行 95.03% / 分支 86.54% / 函数 92.70% |
| `npm audit --omit=dev` | 2 个 moderate（node-cron→uuid，暂缓项） |
| 运行时工具数 | 19 |
| 审阅时 HEAD | `d942c3a`（`main` 领先 `origin/main` 1 个提交） |

审阅方法：主审 + 三路独立子代理交叉复审（文档一致性 / 核心通知链路 / 业务模块），
辅以最小复现脚本与真实数据源联测。审阅过程只读。

## 1. 修复清单与状态

状态图例：`[ ]` 待办；`[x]` 已完成（代码+测试或文档已更新）。

### 1.1 文档过期/缺失/冲突（D）

- [x] **A1** 每日简报文档仍声称包含油价，代码已不含：`README.md:263`、`docs/architecture.md:112-116`、`skill/SKILL.md:40`、`.env.example:37-38`。
- [x] **A2** `docs/repair-plan.md:18` HEAD 哈希过期（写 `6de3657`，实际 `d942c3a`）；`main` 领先 `origin/main` 1 个提交需明确状态。
- [x] **D1** `docs/repair-plan.md:13` holiday 批次数/缺陷项数错误（写 7 批 18 项，实为 6 批、19 个编号缺陷 + 1 个 P3 顺手）。
- [x] **D2** `docs/history/repair-history.md:5` 提交数错误（写 14，实为 12 个区间提交 / 含端点 13）。
- [x] **D3** `docs/holiday-workday-implementation-review.md:3 vs :98` “六轮复审/第七轮最终验收”表述自相矛盾。
- [x] **D4** `docs/holiday-workday-implementation-review.md:5` 变更文件数错误（写 15M+11A，实际 16M+12A，且漏列 repair-plan）。
- [x] **D5** `docs/holiday-workday-implementation-review.md:243-245` 源码行数过期（写 294/395/147，实际 296/468/216）。
- [x] **D6** `docs/holiday-workday-implementation-review.md:274` “既有测试改动仅两处”，实际三处。
- [x] **D7** `README.md:250`、`.env.example:24` `LIFE_ASSISTANT_TIMEZONE` 作用范围写窄（实际也是 schedule 默认时区）。
- [x] **D8** `README.md:211` “成功早退”与 `scheduler.ts` 的 `exitCode=1` 不符。
- [x] **D9** `README.md:280/298`、`skill/SKILL.md:73/81` 未说明 `renderTarget` / `PROFILE_PUSH_ROUTES_JSON` 变更需重启进程。
- [x] **D10** `.env.example` 缺少必填的 `HERMES_PROFILE` 说明。
- [x] **D11** `src/core/location.ts:71` 工具描述仍提及已封存的“快递”。
- [x] **D12** `docs/architecture.md:152` “每个节日休假日连续”与代码“连续段 ≤4”不一致。
- [x] **D13** `docs/architecture.md:41` “MCP 工具只读（缺数据时按规则补齐）”表述自相矛盾。

### 1.2 节假日/工作日模块（H）

- [x] **H1**（P1）校验器拒绝官方真实年份 2013（12 个调休上班日）、2015（特殊纪念日）、2020（工作日非休标记；chinese-days 中秋缺失），两个数据源均失败。
- [x] **H2**（P2）`holiday.next` 的 `from` 只做正则，`2026-02-30` 返回 `today:null` 而不是报错。
- [x] **H3**（P2）`fetchHolidayYear` 的 `AggregateError` 不携带各源失败详情，误拒/网络故障难以诊断。
- [x] **H4**（P3）`ingestHolidayYear` 入口不自校验，可绕过校验写入非法日期并置 ready。
- [x] **H5**（P3）次年官方门槛只检查 `papers` 非空，不校验官方域名。
- [x] **H6**（P3）`nextHoliday.coveredUntil` 对 ready 年份统一写 `12-31`，而视图只覆盖到 `12-19`。
- [x] **H7**（P2）MCP 查询工具补齐节假日数据后不立即 `reconcileHolidaySchedules`，相关 workday/holiday 日程要等下一次 scheduler job 才恢复。

### 1.3 日程模块（S）

- [x] **S1**（P2）`schedule.delete` 不取消/删除已生成但未投递的 `profile_notifications`/deliveries，与工具描述“删除未投递提醒”不符。
- [x] **S2**（P2）普通 RRule 日程创建/更新时 until/count 已耗尽，却落库为 `active + enabled=1 + next_run_at=NULL` 僵尸态。
- [x] **S3**（P2）workday/holiday 的 `until` 不校验真实日历日；非法值被持久化、hydration 时被静默丢弃。
- [x] **S4**（P3）`sanitizeReminders` 对 `[]`/全非法数组返回空集合，scheduler 会补发一条默认提醒后把重复日程置 completed。
- [x] **S5**（P3）非法 `next_run_at` 只在内存清空、不修复 DB；坏值字典序早于 now 时每 tick 重复扫描。
- [x] **S6**（P3）`completeSchedule`/`reconcileHolidaySchedules` 不跳过已完成 occurrence，`next_run_at` 收敛滞后。

### 1.4 通知/投递与配置（N）

- [x] **N1**（P2）`notify.pull` 与旧 route 的 in-flight `sending` 竞态：pull 已读后 route 恢复会再次投递。
- [x] **N2**（P2）route-drift fallback 先于幂等窗口 fallback，超窗的不确定请求在 route 恢复后被重新投递。
- [x] **N3**（P2）`notify.pull` 不区分新鲜/僵尸 `sending` claim，scheduler 崩溃后通知不可投递也不可拉取。
- [x] **N4**（P2）scheduler 每 tick 顺序发送 100×10s 最坏 1000s，存在持续积压风险。
- [x] **N5**（P3）`httpJson` 对 4xx/带 body POST 无差别重试；`redactUrl` 对非法 URL 返回原文可泄漏 query 中的 key。
- [x] **N6**（P3）`DATA_DIR=""` 时 `path.resolve("")` 解析到项目根目录而非默认 `./data`。
- [x] **N7**（P3）非空但非法的 `PROFILE_PUSH_ROUTES_JSON` 被静默解析为空，无任何告警。
- [x] **N8**（P3）`fetch` 使用 `redirect:"error"`，3xx 被归类为 transport-uncertain，与文档“非 2xx 5 次/新 generation”不一致。
- [x] **N9**（P3）MCP server version `0.2.0` 与 `package.json` `0.1.0` 不一致；package description 未包含 holiday。
- [x] **N10**（P3）`schema_meta.version` 无条件写 `'4'`，未来版本库被旧进程打开会降级版本号。
- [x] **N11**（P3）`profile_notifications(profile_id,id)` 普通索引与唯一索引冗余。
- [x] **N12**（P3）Open-Meteo/QWeather 响应缺少运行时形状校验；QWeather forecast 返回空数组不降级。
- [x] **N13**（P3）封存的 express 模块仍在 dist 构建并含 `registerModule`，恢复风险高；`cron.expressPoll` 与其 30 分钟描述不一致。
- [x] **N14**（P3）`currentLocation` env 预置路径不校验 `LOCATION_CITY` 非空。

## 2. 完成记录

- 文档批次：A1、A2、D1-D13 已修改完成（README/architecture/SKILL/.env.example/repair-plan/history/holiday-review）。
- holiday 批次：H1-H7 已修复并有回归测试（2013/2015/2020 真实 fixtures；holiday 相关测试 111 通过）。
- core/config 批次：N5-N14 已修复并有回归测试（config/location/weather/database 测试通过）。
- notifier 批次：N1-N4、N8 已修复并有回归测试（notifier 相关测试 16 通过）。
- schedule 批次：S1-S6 已修复并有回归测试（schedule 相关测试 128 通过；契约测试 11 通过）。

## 3. 验证命令

```bash
npm run build
npm test
git diff --check
```

## 4. 当前状态

- 最终验证（2026-08-15）：`npm test` **370/370 全绿**（原 333 + 新增回归 37）、`npm run build` 零错误、`git diff --check` 干净。
- 真实数据复验：2013/2015/2020 官方 holiday-cn 数据均可通过校验并入库。
- 全部清单项已 `[x]`。
- 工作分支：`fix/final-review-20260815`，已推送 `origin/fix/final-review-20260815`：
  - `6522546` docs: record final review findings and correct stale documentation
  - `22d6fdc` fix(holiday): accept official 2013/2015/2020 calendars and harden validation
  - `1b75bdb` fix(core): harden config, http retries, schema guard and weather providers
  - `c72d531` fix(notifier): close pull/delivery races and bound delivery concurrency
  - `594099c` fix(schedule): align delete, completion and exhausted-state semantics
