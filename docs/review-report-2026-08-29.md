# Life Assistant 全量审查报告（2026-08-29，历史快照）

> 本文记录上一轮审查结果，不代表当前源码状态。当前修复基线为 `79a1c93`，后续修复提交见 git log；请以源码与 `docs/upgrade-config-checklist.md` 为准。

> 审查对象：`main` @ `ec41c01`（第二轮报告 docs/review-report-2026-08-28-round2.md 及其修复提交之后）。
> 覆盖范围：全部 52 个 src 文件（约 13.5k 行）逐行通读；文档全量（README / CONTRIBUTING / docs/architecture / skill/SKILL / .env.example / docs ×6）；`.gitignore`、`package.json`、tsconfig 核对。测试套件本轮以运行验证与针对性核查为主（rrule 星期常量、dist 忽略状态等），未逐行审。
> 验证基线：`tsc --noEmit` 0 错误；`npm test` 536/536 通过；`git status` 干净。
> 历史疑点排除：`solarEventAt` 的 `byweekday.filter(Boolean)`（schedule/service.ts:457）——rrule 2.8 的星期常量是 `Weekday` 对象（truthy，SU=6），SU 不会被误删，实证核查通过。

---

## 1. 总体结论

- 第一、二轮报告的修复逐项回到源码核验，**全部真实落地**（见 §2），且均有回归测试锁定。
- 本轮**未发现 critical / HIGH 级新问题**。新发现集中在四处：
  ① `notify.pull` 会立即送达并取消「已 snooze」的通知，在 SKILL「每次会话 pull 一次」的强制规范下 snooze 语义基本失效（最高优先）；
  ② 损坏的 `next_run_at` 触发 S5 自愈时**静默停用**用户日程且无任何日志；
  ③ docs/architecture.md 的 automation 失败语义与代码/README 自相矛盾；
  ④ `PROFILE_DISPLAY_NAMES` 配置项仅见于 SKILL.md，README 配置表与 .env.example 均缺失。
- 其余为 LOW 级健壮性/一致性问题与文档同步项。

## 2. 前两轮修复落地核验（全部确认）

- **H1** `notify.pull` 返回 `{ count, notifications }`（core/notify-module.ts），通知正文随工具结果回传。
- **H2** snooze 重置 `request_started_at = NULL`、`request_generation + 1`（core/notify-manage.ts），与 route 恢复入队同口径。
- **H3** 油价静态表耗尽后按「每 10 个工作日」续推候选窗口（`calibrated: false`），advance 通知不再停用。
- **M1–M10**：跨账本转账口径（README 单流水设计 + 通知带对端信息）、共享流水跨账本移出限 owner、>48h 延迟发布、previous ±1 分 + retry 告警、`next_adjustment` 容错、import 前 quietHours 预校验、`fence()` 异常兜底 + 投递前租约复核（leaseCheck）、时区/绝对 DATA_DIR 启动校验、正则 lint 契约测试删除、期初流水补发成员通知——逐项确认。
- **L 系列**关键项抽查落地：plain 渲染异常兜底、响应体取消 + 1MB 上限、投递错误并入 errors 聚合、金额 9e12 上限、category/note 空串语义、`version IS ?` 自愈、build clean、版本号单一来源等。
- README「46 个工具」、SKILL「记账 14 个工具」、upgrade-checklist「6 行 registered + 7 jobs」、HMAC V2 / 退避档位可达性、schema version 8 等文档声称与代码一致。

## 3. MEDIUM（功能/逻辑，建议尽快处理）

### M-1. `notify.pull` 立即送达并取消「已 snooze」的通知，snooze 在实际使用中基本失效 — `src/core/notify-manage.ts:211-257`
- **问题**：`pullPending` 的 profileRows 查询只排除 `sent` 与新鲜 `sending` 的 delivery，**不排除 `not_before` 在未来的行**（该列仅被读出做重渲染标签 `pull_not_before`）；返回前还把 pending/failed/fallback 的 delivery 一律置为 `cancelled`（:247-257）。用户执行 snooze（「半小时后再说」）后，只要 Agent 按 SKILL.md:23 的强制规范在会话开始时调用一次 `notify.pull`，通知立即送达且延后投递被永久取消。
- **影响**：`notify.snooze` 的工具描述（core/notify-module.ts:42-44「推迟 minutes 分钟再投递」）与实际语义脱节；snooze 退化为「最多延迟到下一次会话」。渲染附带的「（稍后提醒）」标签说明该路径是半有意的，但与工具契约矛盾。
- **建议**：pull 排除 `not_before > now` 的行——这是唯一能同时保住「pull 后不双发」约束（pull 返回即标记已读、必须取消 delivery）的改法；补一条「snooze 后 pull 不提前返回」的回归测试。

### M-2. docs/architecture.md:87 的 automation 失败语义与代码、README 三方矛盾 — `docs/architecture.md:87`
- **问题**：architecture.md 写「到期即记 `last_run_at`（含失败），避免失败任务每个扫描周期重试」；但 `recordRunFailure`（`src/modules/automation/service.ts:379-394`，第一轮 L34 修复）刻意让 daily 任务失败**不**推进 `last_run_at`，README:290 已同步为「daily 任务当日执行失败不影响当日后续重试」。architecture.md 是过时表述。
- **附带**：该设计的实际代价未注明——daily 任务在 Provider 持续故障时当天以每 10 分钟一次（默认 `AUTOMATION_SCAN_CRON`）重试约 144 次/任务。README 只说「会重试」未说放大倍数。
- **建议**：改写 architecture.md:87 与代码对齐；README/skill 注明重试频率受扫描周期约束。

### M-3. 损坏的 `next_run_at` 静默停用日程，无任何日志 — `src/modules/schedule/service.ts:861-868`
- **问题**：`rowToItem` 的 S5 自愈分支发现 `next_run_at` 非 ISO 时直接 `UPDATE schedules SET next_run_at = NULL, enabled = 0` 后返回，没有日志。同文件已有完善的 `logHydrationError` 去重日志机制（含 5 分钟窗口与容量上限），此处未复用。
- **影响**：数据损坏时用户日程无声消失（不再触发、list 中 enabled=false），排查无线索；且该 UPDATE 同样会经 `assistant.export`、`schedule.list/get` 等「只读」路径触发（见 L3）。
- **建议**：自愈分支记一条日志（可复用 `logHydrationError`），并补自愈断言。

### M-4. `PROFILE_DISPLAY_NAMES` 配置项文档缺失，SKILL 生效说明有误 — `src/config.ts:88-103`、`README.md`（配置表）、`.env.example`、`skill/SKILL.md:97`
- **问题**：该变量（记账通知「记录人」友好名）是 v0.3 后新增配置，但 README 配置表与 .env.example 均未收录，用户唯一可见出处是 SKILL.md。且 SKILL.md:97 写「改 .env 后需重启 scheduler + **网关 + dashboard** 才生效」——该变量只有 scheduler 与 MCP 进程读取，重启网关/dashboard 无作用。
- **建议**：README 配置表与 .env.example 补条目（可选 JSON，形如 `{"default":"我","bestie":"对象"}`）；修正 SKILL 生效说明为「重启 scheduler 与读取该配置的 MCP 进程」。

## 4. LOW

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | `src/modules/schedule/index.ts:88` | `schedule.create` 描述「直至完成/**取消**/达上限」未限定「取消」指删除/关闭日程；与 README:281、SKILL:109「notify.cancel 不会停止强提醒重发」的强调相悖，易诱导 LLM 用 `notify.cancel`（只取消当前 attempt 通知，下一轮 attempt-N+1 照发） | 描述改为「完成/删除日程/达上限」或显式注明 notify.cancel 无效 |
| L2 | `src/core/notify-delivery.ts:274-312` | 投递失败回写使用 SELECT 快照值（`row.attempts`/`row.request_generation`/`row.transport_failures`）；SELECT 与 claim 之间若行被 route 恢复重新入队（attempts=0、generation+1），回写会把 generation 拨回旧值（X-Request-ID 撞号风险）、attempts 回退。单实例内被写锁串行化无窗口，仅实例接管竞态下出现 | claim 时回读行值，或在 SQL 中做算术递增（`attempts = attempts + 1` 等） |
| L3 | `src/modules/schedule/service.ts:861-868` 经 `src/modules/assistant/index.ts:166`、`listSchedules`/`getSchedule` | S5 自愈是写操作，却会在 `assistant.export`、`schedule.list/get` 等「只读」工具路径触发 UPDATE（备份场景产生写副作用、WAL 增长） | 可接受则文档注明；否则自愈仅限 tick/写路径 |
| L4 | `src/modules/schedule/service.ts:976-977` | `listSchedules` 的 `from`/`to` 为 `z.string()` 透传，与 `next_run_at` 字典序比较：垃圾输入静默空结果；且过滤语义是「下次触发时间」而非发生日期，已完成的一次性日程永远落不进任何时间范围 | schema 校验 ISO 日期；描述写清过滤对象是 next_run_at |
| L5 | `src/modules/oilprice/provider.ts:43-97` | 省份解析依赖手工 `CITY_TO_PROVINCE`（约 100 城）；保存位置未带 `province`（location.set 可选）且城市未收录时（如「朔城区」），`oilprice.current` 只能报错并提示重新配置 | 映射失败时回退 GeoAPI `adm1` 解析省份 |
| L6 | `src/modules/weather/provider.ts:298` | QWeather 预报 `Number(d.precip) || undefined` 把非法值（"abc"→NaN）与 0 一样降级为「无降水」，与同文件其他字段「非法即抛错走兜底」的 N12 口径不一致 | 与 requireFiniteNumber 家族统一：畸形值抛错触发 Open-Meteo 兜底 |
| L7 | `src/modules/automation/service.ts:23`、`src/config.ts:168` | automation `interval` schema 允许 ≥5 分钟，但实际由 `AUTOMATION_SCAN_CRON`（默认每 10 分钟）驱动，5 分钟任务最长延迟 10 分钟；工具描述/README 未说明 | create 描述注明「检查频率受扫描周期限制」 |
| L8 | `src/modules/bookkeeping/service.ts:933-949` | 月度账单只在每月 1 号跑上一个自然月；1 号之后补记的上月流水永远不会出现在任何月报（identity 幂等 + 每月一次） | 文档注明；或月初数日内每天重复跑上月 key（幂等） |
| L9 | `src/config.ts:164-166` | `cron.weatherAlerts`、`cron.oilWatch` 硬编码，其余 4 个 cron 均可环境覆盖；README 配置表未提及 | 补 env 覆盖或注明「不可配置」 |
| L10 | `src/modules/bookkeeping/service.ts:761,801` | entry 乐观锁 `WHERE ... version = ?` 不匹配 NULL；schedule 模块为兼容脏行已改 `version IS ?`。`ledger_entries.version` 有 NOT NULL 约束，理论不可达，仅口径不一致 | 统一为 `IS ?`（低优先） |
| L11 | `src/config.ts:58-62` | route URL 仅接受 `127.0.0.1`/`[::1]` 字面量，`localhost`（同为 loopback）被拒；README「只接受 loopback HTTP(S) URL」表述与实现有细微出入（示例用 127.0.0.1，实操无碍） | 文档措辞改为「仅接受 127.0.0.1/[::1]」或放宽主机名 |

## 5. INFO（记录 / 设计取舍）

1. **`createAccount` 的 `initialBalance` 以「期初余额」收入流水落库**（`src/modules/bookkeeping/service.ts:375-391`）：建账户当月的 `summary`/月报 income 会包含期初金额，收入虚高；SKILL/README 未提示。属可选告知项。
2. **`docs/bookkeeping-implementation-plan.md:3` 头部状态仍是「已评审定稿，待实现」**，模块实际已上线；另两份历史文档（v0.3-capabilities-acceptance、holiday-workday-implementation-review）都加了「已归档」标注，这份没有，建议补齐避免误读。
3. **`notify.list` 不展示 `not_before`/attempts**：排查 snooze 状态时只能从通知正文的重渲染标签间接判断；可选增强。
4. express 模块封存如旧（EXPRESS_ENABLED 护栏），本轮未发现新的运行时风险。

## 6. 文档一致性核对

| 声称 | 实际 | 结论 |
|---|---|---|
| README「46 个 MCP 工具」 | location 3 + weather 4 + airquality 1 + oilprice 2 + schedule 6 + holiday 4 + notify 5 + automation 5 + bookkeeping 14 + assistant 2 = 46 | ✅ |
| SKILL「bookkeeping 共 14 个工具」 | 14 | ✅ |
| upgrade-checklist「6 行 registered + started, 7 jobs」 | 6 模块 cron + 1 内置 tick | ✅ |
| HMAC V2 `timestamp.body`、10s 超时、禁重定向、55 分钟幂等窗口、退避档位可达性、claim/fencing | notify-delivery.ts 逐行核对 | ✅ |
| schema version 8 及护栏 | database.ts `> 8` 拒绝、戳 '8' | ✅ |
| 静默时段/pull 不受限、snooze 拒绝窗口内不确定失败、cancel 写 read | notify-delivery / notify-manage 核对 | ✅ |
| 强提醒默认 120/3、occurrence 正式提醒前置校验、轮次标记、clearStrongReminder | schedule service/tick/notification 核对 | ✅ |
| 记账金额 9e12 上限、两位小数、余额派生、权限模型、joined_at 截断 | bookkeeping service 核对 | ✅ |
| architecture.md:87 automation「到期即记 last_run_at（含失败）」 | 与 recordRunFailure（daily 失败不推进）矛盾 | ❌ 见 M-2 |
| `PROFILE_DISPLAY_NAMES` 配置文档 | 仅 SKILL.md 收录，README/.env.example 缺失 | ⚠ 见 M-4 |

## 7. 修复优先级建议

1. **立即**：M-1（pull 排除 `not_before` 未来行 + 回归测试）；M-3（自愈分支补日志，一行改动）。
2. **本周**：M-2 / M-4（architecture.md automation 段改写；README 配置表与 .env.example 补 `PROFILE_DISPLAY_NAMES`；SKILL.md:97 生效说明修正）。
3. **随手**：L1（create 描述措辞）、L6、L9、INFO-2（bookkeeping 计划文档归档标注）。
4. **测试补强**：snooze 后 pull 不提前返回的用例；S5 自愈日志断言；`listSchedules` 非法 from/to 的行为用例。

---

*本报告为只读审查产物；除本文件外未修改任何项目文件。*
