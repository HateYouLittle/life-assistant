# Life Assistant 全量审查报告（2026-08-28）

> 审查对象：`main` @ `bdf4711`，覆盖全部 52 个 src 文件（约 9.8k 行）、45 个测试文件（约 12.6k 行）、全部文档（README / CONTRIBUTING / docs ×6 / skill / .env.example / LICENSE）。
> 方法：主审查员逐行复核核心层、配置、文档与关键模块；6 个只读子代理分区深审（核心层 / 生活数据模块 / 日程与自动化 / 记账与助手 / 测试套件 ×2）；所有关键发现均回到源码二次验证行号与行为。
> 验证基线：`tsc --noEmit` 0 错误；`npm test` 480/480 通过；`npm audit` 2 个 moderate（详见 §3.3）。

---

## 1. 总体结论

**项目整体质量显著高于平均水平**，与仓库内多轮修复/复审历史（docs/history/repair-history.md）所反映的工程投入一致：

- 架构分层清晰（MCP 查询面 / 独立 scheduler 通知面 / SQLite outbox / Hermes Webhook），模块边界由 registry 强制；
- 安全基线扎实：HMAC V2 出站签名、URL 脱敏（`redactUrl`）、loopback-only 路由校验、null-prototype 路由表防原型污染、SQL 全参数化、Profile 隔离与「绝不按普通周历猜测节假日」等硬性约束均有测试锁定；
- 数据完整性设计突出：outbox 状态机（claim token / request_generation / 55 分钟幂等窗口 / route 漂移恢复）、schedule 的版本乐观锁 + 脏行自愈、节假日数据按日期范围原子入库、记账金额以分为单位由流水派生；
- 测试 480 个全绿，跨年/闰月/时区/午夜边界与历史回归点（T/H/K/M/N/P/S 系列）覆盖极密，fixtures 与真实年份数据核对一致。

**主要风险集中在三处**：① `notify.pull` 重构回归导致通知正文丢失（HIGH）；② snooze 与幂等时钟的状态重置不一致（HIGH）；③ 油价调价窗口表仅覆盖 2026 年、数月后将静默停用 advance 通知（HIGH）。其余为中等/低等级的可审计性、状态机边角与测试维护问题。

**未发现 critical（安全可利用 / 资金破坏 / 必然崩溃）级问题。**

---

## 2. HIGH（建议尽快修复）

### H1. `notify.pull` 工具只返回 count，拉取即标记已读并取消投递，通知正文永久丢失 — `src/core/notify-module.ts:26`
- **问题**：commit `61cc073` 重构把返回值从 `ok({ count, notifications })` 退化为 `ok({ count: pullPending(...).length })`。`pullPending`（notify-manage.ts:247-253）在返回前已把通知标记已读、把 pending/failed/fallback delivery 置为 `cancelled`；通知内容（title/body）不再出现在工具结果中。SKILL.md:23 要求 Agent「调用一次 notify.pull，转述当前 Profile 尚未成功主动投递的通知」，Agent 只能拿到一个数字，无法转述。
- **证据**：重构前 `return ok({ count: notifications.length, notifications })`（git show 61cc073）；重构后仅 `ok({ count: ... })`。测试全部直接调 `pullPending` 核心函数，工具包装层的返回形状无任何断言（480/480 全绿却未拦截）。
- **影响**：投递失败/fallback/无 route 的恢复路径被静默截断——用户被告知「有 N 条未读」，但内容已经不可见且主动投递已被取消。这是 README 声称的 `notify.pull` 兜底语义的核心破坏。
- **建议**：恢复返回 `{ count, notifications }`（含 id/title/body/time/source/scope）；补一条工具级测试锁定返回形状；同步确认 SKILL.md 的转述流程。

### H2. snooze 不重置 `request_started_at`/`request_generation`：snooze 后一次失败即被误判幂等窗口超期而终态 fallback — `src/core/notify-manage.ts:91-97`（配合 `src/core/notify-delivery.ts:59-80,179,224,276-278`）
- **问题**：snooze 把行重置为 pending 时只清 `attempts/transport_failures/claim`，保留 `request_started_at`（首次 claim 时间）与 `request_generation`。投递期 claim 用 `COALESCE(request_started_at, ?)` 沿用旧值 → 55 分钟幂等窗口仍从最初一次请求起算。一条 failed 超过 55 分钟的行被 snooze 后，新投递再失败一次，下一 tick 的幂等窗口扫描（notify-delivery.ts:66-79）立即将其置为终态 `fallback`，`[60,300,900,3600]` 重试阶梯被整体跳过；且新投递沿用旧 `X-Request-ID`，若旧请求其实已到达 Hermes，网关侧幂等可能吞掉这条 snooze 后的提醒。
- **证据**：notify-manage.ts:91-97 的 UPDATE 无 `request_started_at`/`request_generation` 字段；docs/architecture.md:120「保持 request_generation」的注释只对 55 分钟窗口内的不确定失败成立——而窗口内的不确定失败已被 snooze 拒绝（notify-manage.ts:84-88），因此能通过 snooze 的行其 `request_started_at` 必然已过期，该注释的前提实际不存在。
- **影响**：用户主动「稍后提醒」后大概率只有一次投递机会，失败即永久 fallback（只能靠 pull 兜底——而 H1 又让 pull 丢内容）；重试阶梯名存实亡。
- **建议**：snooze 的 UPDATE 增加 `request_started_at = NULL, request_generation = request_generation + 1`（与 route 恢复入队 notify-delivery.ts:113-119 同口径），并同步修正 architecture.md:120 的注释。

### H3. 油价调价窗口表仅覆盖 2026 年，表用尽后 advance 通知静默停用、`oilprice.next_adjustment` 直接报错 — `src/modules/oilprice/schedule.ts:14-20`（配合 `watch.ts:244-249`、`index.ts:53-56`）
- **问题**：`ADJUSTMENT_WINDOWS_2026` 只有 25 个 2026 年窗口。`nextWindow()` 超出表范围返回 null → watch 每日仅 `console.error` 一条后 advance 通知永久关闭；`oilprice.next_adjustment` 工具返回 fail（「年度窗口表未覆盖当前日期」）。当前日期 2026-08-28，距表耗尽（2026-12-24 之后）不足 4 个月。README 将「下一次调价窗口与提前通知」列为当前能力，未提示此年度维护负担；测试输出中已出现该耗尽告警。
- **影响**：确定性的能力降级（需要改代码 + 重新构建部署才能恢复），且对用户只在 scheduler 日志中可见；`next_adjustment` 查询从 2027-01-01 起对用户报错。
- **建议**：① 立即补 2027 年窗口表（按公开日历 + 正式结果校准）；② 中期：表外年份按「每 10 个工作日」规则自动生成候选（带人工校准标记）或把降级写入用户可见通知；③ README 增加维护说明。

---

## 3. MEDIUM

### M1. 跨账本转账只落一条流水，对端账本余额变化无流水凭证，与 README 表述存在歧义 — `src/modules/bookkeeping/service.ts:521-529,303-316`（README:361）
- 一笔 transfer 只有一条 entry、只能归属一个账本；当两端为「个人账户↔共享账户」或「两个不同共享账户」时，对端账户余额随 `BALANCE_SQL`（跨账本 `WHERE account_id=? OR to_account_id=?`）变化，但对端账本的 `entry_list`/`summary` 查不到这笔流水。README「跨账本转账自动记入共享账本使双方成员可见」与实际（通知可见、流水不可见）不符；实施方案（docs/bookkeeping-implementation-plan.md §3）明确选择单流水，因此这是文档口径问题 + 可审计性缺口。
- **建议**：要么在通知 payload 中带上对端账户/账本信息并在 README 写明「对端流水不可见」，要么转账拆为双流水（需事务原子）。

### M2. 成员可把自己记录在共享账户上的流水改挂到个人账本，共享余额被静默改变且事后不可审计 — `src/modules/bookkeeping/service.ts:606-610,688-689,713-716`
- `requireEntryForWrite` 允许「记录人本人」改删；`updateEntry` 改 `accountId` 后经 `resolveEntryLedger` 重算归属，可以把流水从共享账本整体挪进个人账本。该金额从共享池余额中消失，对其他成员只表现为一条不含账户信息的 "update" 通知。
- **建议**：共享账本流水移出（改挂个人账本）要求 owner 权限；或至少在 shared_entry 通知 payload 中带上新旧 accountId/账本留痕。

### M3. 油价正式调价结果在两条路径被静默丢弃，无补发机制 — `src/modules/oilprice/watch.ts:192-209`
- (a) `timestamp > effective + 48h` 直接 baseline 不发通知：scheduler 停机 >2 天或数据源延迟发布时，该窗口正式结果永久丢失；(b) `windowDate === state.windowDate` 且证据完整时只 rebaseline 返回 "ignored"，同样从不发布。用户收到 advance notice 后永远等不到正式结果。
- **建议**：超窗时仍允许发布一次（标注延迟）或至少落日志 + state 记录 pending 窗口；同窗完全证据路径视为待发布。

### M4. 三油品 previous 严格相等使状态机永久 retry（无日志、无通知、不前进） — `src/modules/oilprice/watch.ts:118-127,210`
- `completeAndConsistent` 要求三油品 `previous` 与本地 state 严格相等；任一相差 1 分即 `retry`，而 retry 分支不落日志、不发布、不推进 state，每日重复且完全静默。对比 `completeAdjustmentEvidence` 已放宽 ±1 分，两处口径不一致。
- **建议**：previous 校验放宽到 ±1 分（与 evidence 同口径），并对连续 retry 输出告警。

### M5. TianAPI `next_adjustment` 是全链路死字段却被硬解析，缺失即废掉主源 — `src/modules/oilprice/provider.ts:175-176,189`
- `nextWindowDate` 在 provider/watch/notification 全链路无人消费（grep 确认），但 `providerDate(result.next_adjustment)` 解析失败会抛出，整条 TianAPI 结果作废降级 JUHE，丢失 adjustmentEvidence。上游可选字段的缺失/格式变化会无谓地切断主数据源。
- **建议**：`next_adjustment` 改为可选容错读取或直接删除。

### M6. `assistant.import` 中途异常导致「部分导入 + 整体报错」，已导入数据不回滚 — `src/modules/assistant/index.ts:281-290`
- schedules/automations 循环导入完成后才应用 quietHours；`saveQuietHours` 对非法时区 throw（schema 层只做 `z.string()`），withTool 把整个 import 变成 ERROR，但前面已导入的条目不回滚且 ImportSummary 丢失，用户无从得知哪些已导入。
- **建议**：导入前对 quietHours/location 整段预校验，或把四类数据应用包进事务。

### M7. scheduler 心跳 `fence()` 无异常保护，SQLITE_BUSY 即可崩掉调度进程 — `src/scheduler.ts:89-95,106-108`
- `refreshSchedulerLease` 的 `prepare().run()` 在 `busy_timeout=5000` 后仍拿不到写锁会抛 SQLITE_BUSY；该异常从 `setInterval` 心跳回调未捕获地冒泡，直接终止 Node 进程（仅靠 systemd Restart 兜底）。此外租约只在 `runFenced` 开头刷新一次，tick 内长网络调用 + 45 秒投递预算期间无续租，理论上可被第二实例在 TTL 后接管。
- **建议**：`fence()` 内 try/catch，BUSY 时记录日志并跳过本轮；长任务内关键路径（投递 claim 前）增加租约复核。

### M8. `LIFE_ASSISTANT_TIMEZONE` 与 `DATA_DIR` 无启动校验 — `src/config.ts:85-87`
- 非法时区字符串不报错（表现为 daily brief job 每日抛「invalid daily brief timezone」）；`DATA_DIR` 用 `path.resolve` 相对 cwd 解析，README 要求绝对路径但代码不强制——systemd 与各 Profile MCP 进程 cwd 不一致时会静默指向不同库，破坏「所有进程共享同一 DATA_DIR」的架构前提。
- **建议**：启动时校验 `DateTime.now().setZone(timezone).isValid`，非法即 throw；要求 `path.isAbsolute(DATA_DIR)`。

### M9. `tests/scheduler-notification-contract.test.ts` 是源码文本正则 lint，不是行为测试 — `tests/scheduler-notification-contract.test.ts:5-24`
- 整个文件用正则锁定 scheduler.ts/registry.ts/modules/index.ts 的**字面排版**（精确到引号与空格）。任何合法重构（变量改名、prettier 重排）都会破坏测试；反之匹配成功也不能证明「tick 真的被调用且错误不吞掉」。architecture.md:34 明确依赖该「契约测试」守护模块边界——守护者本身脆弱。其语义已由 profile-schedule.test.ts 的 `runSchedulerTick` 端到端用例覆盖。
- **建议**：改造成运行时断言（registry 探针统计 tick 调用），或降级为 CI 静态检查并标注「格式断言，重构需同步」。

### M10. 共享账户带 `initialBalance` 的「期初余额」流水不通知成员 — `src/modules/bookkeeping/service.ts:362-388`
- `createAccount` 直接 `insertEntryRow` 落期初流水，未走 `notifySharedEntryChange` 路径；owner 用 initialBalance 建共享账户时，其他成员只看到余额凭空增加。与「共享账本内记账互相通知」的语义不一致。
- **建议**：opening entry 落库后补发成员通知。

---

## 4. LOW

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | `src/core/notification.ts:176-190` | markdown 分支有 catch 回退 plain，但 plain 分支自身无异常保护；某 kind 渲染器对 plain 也抛错时，异常逃逸整条发布链，通知未落库即丢失 | plain 分支同样包 catch，最终用 headline+details 兜底 |
| L2 | `src/core/notify-delivery.ts:279-284` | 传输失败路径 `transport_failures>=3`（第 3 次失败）即 fallback，`retrySeconds[3]=3600` 档对传输失败不可达（55 分钟幂等窗口先到）；注释/README 的「1 分钟、5 分钟、15 分钟、1 小时」与实现语义有噪音 | 删死档或统一档位表并注释幂等窗口约束 |
| L3 | `src/core/http.ts:39-43`、`src/core/notify-delivery.ts:239-242` | 非 2xx 分支不消费响应体，undici 连接不可复用；高频失败投递时连接反复重建；无响应大小上限 | 失败分支 `response.body?.cancel()`；httpJson 增加 content-length 检查 |
| L4 | `src/scheduler.ts:57-60` | `deliverPendingProfileNotifications` 抛错时，模块 tick 的错误数组被整体丢弃，只上报投递错误 | deliver 包 try/catch 并入 errors 统一抛 |
| L5 | `src/core/database.ts:62-67` | `profile_notification_reads` 的 FK 只引用 `profile_notifications(id)`（父表主键是复合键 (profile_id,id)，单列不唯一），跨 Profile 同 id 行无法被 FK 区分；当前无删除路径属 latent，未来清理逻辑会误级联 | FK 改为 (profile_id, notification_id) 复合引用（需重建表迁移） |
| L6 | `src/config.ts:91-92` | `LOCATION_LAT/LON` 用 `Number()` 解析，非数字串产生 NaN（读取侧 location/index.ts:43 有 isFinite 兜底，故无实际毒化）；lat/lon 不成对时不告警 | 解析时校验有限性 + 成对，非法视为未配置并告警 |
| L7 | `src/modules/weather/notification.ts:81-89` | legacy 预警去重键用 UTC 日期（`toISOString().slice(0,10)`），新 identity 用配置时区本地日期；UTC/本地日界错开时升级迁移窗口存在去重盲区 | legacy 键日期改为与 identity 同源的本地日期 |
| L8 | `src/modules/weather/provider.ts:221,274` | 和风 GeoAPI 返回的 `loc.id` 仅校验非空字符串、未校验字符集，直接拼进请求 URL（geo.ts:60） | id 加 `^[A-Za-z0-9]+$` 校验或 encodeURIComponent |
| L9 | `src/modules/weather/index.ts:64-65`、`provider.ts:306-309` | 简报 dedupe 的「今天」用 config.timezone，Open-Meteo 预报按坐标当地时区（timezone=auto）切日；海外位置或未显式配置时区时「今日」语义错位 | Open-Meteo 请求显式传与简报一致的时区；README 强调必须设置 LIFE_ASSISTANT_TIMEZONE |
| L10 | `src/modules/assistant/index.ts:118-123` | 导出对 params_json/schedule_json 直接 JSON.parse，单行损坏拖垮整个导出（与 schedule 的 parseJson 容错模式不一致） | 复用 parseJson 式兜底并给提示 |
| L11 | `src/modules/bookkeeping/service.ts:43-51` | 金额无上限，>9e13 元时分值超过 Number.MAX_SAFE_INTEGER 精度失真 | amountYuanSchema/toCents 加合理上限 |
| L12 | `src/modules/bookkeeping/index.ts:184-189` vs `service.ts:679,685` | entry_update 的 category `z.string().min(1)` 拒绝空串，service 的清空分支（`trim() || undefined`）永远不可达；note 空串存为 "" 而非 NULL | category 放开空串用于清空；note 空串归一为 NULL |
| L13 | `src/modules/bookkeeping/service.ts:781-788`、`index.ts:214-216` | summary 的账户余额是当前实时值而非所选月份月末快照，工具描述未说明 | 描述明示「余额为当前实时值」 |
| L14 | `src/modules/bookkeeping/notification.ts:62-74` | shared_entry 通知 payload 不含账户/账本切换信息，跨账本移动时成员无法定位影响面 | payload 增加 accountId/toAccountId（或新旧 ledgerId） |
| L15 | `src/modules/bookkeeping/service.ts:810-827` | 月度账单共享账本段按全账本整月汇总，新成员会收到其加入之前的数据 | 按 joined_at 截断或文档注明 |
| L16 | `src/modules/bookkeeping/service.ts:612-614` | 版本冲突错误消息「expected version X」语义误导（实际是当前值≠X），并发删除也报成冲突 | 改文案并区分「条目已不存在」 |
| L17 | `src/modules/bookkeeping/service.ts:423` | `updateAccount` 对全空白 name 静默回退旧名而非拒绝 | 显式报错 |
| L18 | `src/modules/bookkeeping/service.ts:61-63` | `monthKeyOf` 死代码（tsconfig 未开 noUnusedLocals） | 删除或使用 |
| L19 | `src/core/registry.ts:49` | `fail((error as Error).message)` 对非 Error 抛出（`throw "str"`）输出 "ERROR: undefined" | 用 String(error) 兜底 |
| L20 | `dist/core/location.js` | tsc 不清空 outDir：location 模块重构后遗留的陈旧产物（src 无对应文件），可能误导排查 | build script 加 clean（如 `rm -rf dist && tsc`） |
| L21 | `package.json:3`、`src/index.ts:11` | package 版本 0.2.0 落后于 v0.3 功能集；MCP server version 硬编码同串，与 package.json 有漂移风险 | 版本号升到 0.3.x；server version 从 package.json 导入 |
| L22 | `docs/upgrade-config-checklist.md:169-171` | 注册 job 数量过期：现为 6 个模块 cron（含 bookkeeping.monthly_report）+ 1 tick = 7，文档仍写 5 注册 + 6 汇总 | 同步更新 |
| L23 | `.gitignore` | `.zcode/`（会话计划文件）未被忽略且当前 untracked | 加入 .gitignore |
| L24 | `src/scheduler.ts:138` | 注释「投递最坏 100×10s」过期（现为 5 worker × 45s 预算） | 更新注释 |
| L25 | `src/modules/location/index.ts:29-37` | 已存位置脏数据时直接 return null，跳过 env 预置兜底（有合法 env 时仍需一轮确认） | 脏数据分支清除键后继续走 env 兜底 |
| L26 | `src/modules/oilprice/provider.ts:229` | JUHE 命中用响应原始 `hit.city` 落 province（如「江西省」vs「江西」），与 TianAPI 归一口径不同，切换数据源后 state 分裂 | JUHE city 同样过 `provinceOf` 归一 |
| L27 | `tests/holiday-module.test.ts:77` | 断言 `jobs[0].cron === "0 2 * * *"` 未先清除 HOLIDAY_REFRESH_CRON env，开发者 shell/CI 导出该变量即假阳性 | 断言前 delete env |
| L28 | `tests/profile-schedule.test.ts:119-124` | `delete process.env.HERMES_PROFILE` 未放 try/finally，断言失败会连锁破坏后续用例 | try/finally 恢复 |
| L29 | `tests/holiday-calendar.test.ts:188` | `coveredUntil === "2025-12-19"` 硬编码日期哨兵，与视图窗口语义耦合，调整窗口时误报 | 抽常量导出后引用 |
| L30 | `tests/profile-schedule.test.ts:778,864,951,1022,1101` 等多处 | 共享 DB 内「全量 UPDATE cancelled」清理依赖严格用例顺序，重排/插用例即红 | 按 dedupe_key 定向清理 |
| L31 | `tests/notify-management.test.ts:189-213` | cancel 用例的 `attempted === 0` 依赖前一用例投递副作用 | 用例开头显式清理非终态 delivery |
| L32 | `tests/oilprice-integration.test.ts:98-110` | 「发布先于状态写」的断言只验证最终行数，钉不住时序 | flaky 失败后立即断言通知行数 |
| L33 | `tests/platform-renderer.test.ts` | markdown 异常回退 plain（README:330 声称）与未知 kind fallbackBlocks 无测试 | 注入未知 kind / 会抛错的 payload 各补一例 |
| L34 | `src/modules/automation/service.ts:343-349` + `197-214` | daily 任务一次执行失败也写 `last_run_at`，当天剩余扫描被 `hasSame(day)` 全部拦截，Provider 短暂抖动即丢一整天（architecture.md:87 记录了该设计，但 README 未提示「daily 当日一次失败即当日不再执行」；与 interval 行为不对称） | 失败路径仅对 interval 写 last_run_at，或增加有界重试；至少在工具描述/README 注明 |
| L35 | `src/modules/automation/service.ts:307-320` | 失败路径 `last_result = COALESCE(?, last_result)` 保留旧的「成功结果」，list 展示出现「旧成功结果 + 新错误」并存的语义含混 | 失败路径置 NULL 或 payload 增加 error 标记 |
| L36 | `src/modules/automation/service.ts:244-253,216-226` | 条件 DSL：字符串值按字典序比较（`"9" > "10"` 为 true）；dot-path 无结果字段白名单，拼写错误创建时不报错，`__proto__` 等段可探到原型链对象（只读、无注入，但语义不可控） | 创建时按 action 已知结果字段校验 field；字符串比较仅允许 ==/!= 或显式文档化 |
| L37 | `src/modules/automation/service.ts:291-301,375-384` | `automation.run` 的 identity 用分钟桶（`:run:HH:mm`）、scan 用本地日期，两者同一分钟命中同一任务会以不同 dedupe 键双发通知（描述声称「同一分钟内重复执行会去重」） | run 复用 scan 的当日 identity |
| L38 | `src/modules/schedule/service.ts:179-221` | 直接调 service 的路径（如 assistant.import，其 schema 对 recurrence 是 z.unknown()）可写入 byMonthDay 99 等 MCP 层会拒绝的值；读取侧 sanitizeRecurrence 会丢弃越界值兜底，写入/读取口径不一致 | normalizeRecurrence 补齐与 MCP 层相同的范围校验 |

---

## 5. INFO（记录 / 设计取舍 / 维护提示）

1. **依赖审计**：`npm audit` 2 moderate（node-cron → uuid 8.3.2，GHSA-w5hq-g745-h8pq，v3/v5/v6 的 buf 路径）。node-cron 仅用 `uuid.v4()`（node_modules/node-cron/src/{storage,scheduled-task,background-scheduled-task}），受影响路径不可达；修复需等 node-cron 大版本。已在 repair-history 记录。
2. **IP 探测走明文 HTTP**：`src/modules/location/index.ts:107` `http://ip-api.com/json/`，仅用于建议值不自动落库；建议改 HTTPS（成本极低）。
3. **chinese-days 兜底下 12/20–12/31 普通日期 `is_workday` 报「数据缺失」**：这是 architecture.md M2「绝不按普通周历猜测」的明确设计，非 bug；仅提示用户侧后果（降级源场景下年末普通日期查不了）。
4. **`windowDate = last_adjusted − 1` 的语义未钉死**：fixture（20260801 → 07-31）与真实调价新闻（2026-05-08）均与静态表对齐，当前推导正确；但 ±1 天容差（watch.ts:163）会掩盖未来错位。建议加一条真实样本的注释级断言。
5. **封存 express 模块残留**：`src/modules/express/index.ts`（`EXPRESS_ENABLED=1` 护栏）、`provider.ts:132-140 detectCompany` 死代码、`config.ts:100-103 kuaidi100` 配置、`registry.ts:21 JobContext.notify`（注释自认唯一消费者是 express）。零运行时影响；README 未登记 `EXPRESS_ENABLED`。
6. **`global_notifications` 为纯兼容遗留**：唯一写入者是 `migrateLegacyJson`；pull 的 global 分支只服务存量数据，与 architecture.md §2 一致。建议注释说明避免误导。
7. **出站签名无入站验证路径**：当前不存在 HMAC 比较点，无需 timingSafeEqual；若未来加入对 Hermes 回传签名的验证，必须使用 `crypto.timingSafeEqual` 并先校验长度。
8. **`lunar-javascript.d.ts` 全 any**：Solar/Lunar/LunarYear 均为 any，成员访问绕过类型检查。
9. **`scheduler.ts:11 export { notifyModule }`** 无消费方；`notification-publisher.ts:24` 的 `?? "plain"` 尾部不可达。
10. **fixture 卫生**：`holiday-cn-2004/2019.json` 的 papers 是占位 URL（`content_example.htm`，能通过 gov.cn 域过滤）；fixtures 均为构造/合成值而非真实 API 原始响应（tianapi/juhe/qweather 三份与解析器自洽，但不防 API 字段漂移）。
11. **幂等窗口 55 分钟边界无止点测试**（snooze 拒/收只测 20min/60min 两点）。
12. **interval 自动任务通知按本地日期去重**：每轮 Provider 照常调用，但通知一天只发第一条（README:290 已声明「每个本地日期最多主动提醒一次」，属文档化设计；建议在 create 工具描述中显式提示 interval 任务的提醒频次为每日一次，避免用户误期待每轮提醒）。
13. **`minutesBefore` ≥ recurrence 间隔时相邻 occurrence 提醒同刻并发**（如 daily + minutesBefore:1440）：同一 tick 会同时发布「今天正式提醒」与「明天提前提醒」两条；数学上正确，属 UX 设计边界，可在 create 描述中补充说明。
14. **automation 无乐观锁**：scan 执行期间被 update 修改，本轮按旧参数执行并落 last_result，下轮收敛；低概率脏结果，可接受或参照 schedule 加 version 列。
15. **死代码补充**：`schedule/service.ts:1294-1296 reminderMinutes()`、`automation/actions.ts:91-93 listAutomationActionNames()` 无调用方。
16. **workday/holiday count 计数复核**：`countPriorHolidayAwareMatches` 采用「先递减再计数」模式，实际统计 `[anchor, beforeDate)` 半开区间（锚点日被计入），与扫描段不重不漏；曾有审查意见怀疑锚点日漏计导致多触发一次，逐行复核为误报，且现有测试（「workday occurrence honours count including occurrences before from」等）已锁定该行为。

---

## 6. 测试覆盖缺口（按 src 文件，来自测试审查子代理并经抽查确认）

- `src/core/database.ts`：**`migrateLegacyJson` 完全无测试**（store.json → kv/global_notifications/read 迁移、备份、marker 幂等）；DATA_DIR 不可写路径。
- `src/core/notify-delivery.ts`：>100 行截断、45s 预算中断、无 profileIdFilter 的全局分支、stale sending 行无 read 守卫下的重认领、AbortSignal 真实超时。
- `src/core/notify-publish.ts`：suppressRetainedGlobal / legacy 键整键复用、profile 级 legacy 键提升、`notify(title,body,dedupeKey)` 带键变体、无 route 时 fan-out 0 行。
- `src/core/notify-manage.ts`：snooze 参数校验（非整数/越界）、list 1-100 截断、无 route Profile 的 pull 分支。
- `src/core/notification.ts`：未知 kind → fallbackBlocks、markdown 异常 → plain 回退。
- `src/modules/weather/provider.ts`：和风 now 缺失降级、7d 路径、fetchIndices 和风成功路径、fetchAlerts 空数组。
- `src/modules/airquality/provider.ts`：网络层成功/降级、缺 category 按 AQI 兜底分级。
- `src/modules/holiday/provider.ts`：畸形载荷拒绝族（非对象/year 非整数/days 非数组/中文名校验）、年份范围守卫、secret 脱敏分支、补班>12/段>4。
- `src/modules/holiday/calendar.ts`：nextHoliday 无后续安排终态、year-1<2004 边界、cooldown skip。
- `src/modules/holiday/index.ts`：refresh 的 force 路径、is_workday/next 缺省今天、runHolidayRefresh。
- `src/modules/schedule/service.ts`：listSchedules 过滤族、create/update/complete/delete 的报错路径族、byMonthDay、真实并发版本冲突。
- `src/modules/automation/service.ts`：list 过滤、非法 import id、daily 非法时区、interval lastRunAt 不可解析、runAutomationNow 未知 action；**真实 4 个 action 与 paramsSchema 从未被执行**（全部用 mock action 表）。
- `src/modules/location/index.ts`：resolveLocation 回退链、location.get/detect/set handler、已存位置优先于 env。
- `src/modules/assistant/index.ts`：automations 超 1000 截断（只测了 schedules）、非法 quietHours 传播、province 往返。
- `src/modules/oilprice/index.ts`：位置未确认 fail 路径。

---

## 7. 文档一致性核对（抽查全部通过，仅两处偏差）

| 声称 | 实际 | 结论 |
|---|---|---|
| README「46 个 MCP 工具」 | location 3 + weather 4 + airquality 1 + oilprice 2 + schedule 6 + holiday 4 + automation 5 + bookkeeping 14 + assistant 2 + notify 5 = 46 | ✅ |
| schema version 8（upgrade-checklist/architecture） | database.ts 护栏 `> 8` 拒绝、戳 '8' | ✅ |
| HMAC V2 `timestamp.body`、10s 超时、禁重定向、55 分钟幂等窗口、退避阶梯、claim/fencing | notify-delivery.ts 逐行核对 | ✅ |
| 节假日校验清单（七节日/四节日口径、补班必周末、20-45 天、跨年 12/20、papers 门槛） | provider/calendar 核对 + fixtures 2004/2013/2015/2019/2020/2025 真实数据核对 | ✅ |
| 强提醒语义（默认 120/3、interval>=recurrence 警告、轮次标记、clearStrongReminder） | service.ts / tick.ts / SKILL.md | ✅ |
| 记账金额口径、乐观锁、余额派生、月度账单幂等 | bookkeeping service 核对 | ✅ |
| `notify.pull` 兜底「保持可 pull」 | 行仍可 pull，但工具只回传 count（H1） | ❌ 见 H1 |
| README:361「跨账本转账…双方成员可见」 | 通知可见、对端流水不可见 | ⚠ 见 M1 |
| upgrade-checklist「5 行注册、6 jobs」 | 现为 6 模块 cron + 1 tick = 7 | ⚠ 见 L22 |

---

## 8. 修复优先级建议

1. **立即**：H1（一行回归修复 + 工具级测试）；H2（snooze UPDATE 补两列 + 文档注释修正）。
2. **本周**：H3（补 2027 窗口表）；M3/M4/M5（油价状态机三连，可合并为一个修复批）。
3. **本迭代**：M1/M2/M6/M10（记账审计与导入原子性）；M7/M8（scheduler 与配置健壮性）。
4. **随手清理**：L20/L21/L22/L23/L24（构建清洁、版本号、文档同步）。
5. **测试补强**：按 §6 清单优先补 `migrateLegacyJson`、notify.pull 工具形状、markdown 回退、snooze 55 分钟边界、真实 automation action 契约。

---

*本报告为只读审查产物；除本文件外未修改任何项目文件。*
