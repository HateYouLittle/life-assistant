# 修复历史归档（2026-08-13 ~ 2026-08-14 修复链完整记录）

> 本文件是 life-assistant 修复链的完整历史存档：问题清单、历轮审查发现、进度日志。
> 修复链已收官（2026-08-14），当前状态见 [../repair-plan.md](../repair-plan.md)。
> 归档提交：`b274d08` → `fedd467`（14 个提交，基线 171 → 222 测试）。

## 原始问题清单（全部 done）

### P1（必须修，12 项全 done）

| # | 问题 | 文件:行 | 负责 | 状态 |
|---|---|---|---|---|
| P1-01 | API Key 随错误消息进日志/MCP 回传 | core/http.ts:14; weather/provider.ts:136,171,238; weather/index.ts:178 | W | done |
| P1-02 | 和风业务错误码未检查，预警静默为空 | weather/provider.ts:193-235 | W | done |
| P1-03 | location.set 经纬度无范围校验、city 空串 | core/location.ts:18-23 | W | done |
| P1-04 | v7 location 坐标顺序 lat,lon 应为 lon,lat | weather/provider.ts:123,159 | W | done |
| P1-05 | fallback 终态：route 同名恢复无法重新投递 | core/notifier.ts:187-201,280-292 | 主 | done |
| P1-06 | notify(title,body) 二参形式内容错位 | core/notifier.ts:429-430,99-103 | 主 | done |
| P1-07 | schedule hydration 形状错误 → 永久 poison 行 | schedule/service.ts:38-44,347-354 | S | done |
| P1-08 | scheduler 乐观锁不检查 changes（陈旧通知） | scheduler.ts:168-176 | 主 | done |
| P1-09 | recurring 窗口内创建/更新静默跳过当天提醒 | schedule/service.ts:295-345 | S | done |
| P1-10 | 油价窗口表仅到 2026，跨年后静默失效 | oilprice/schedule.ts:14-20; index.ts:59 | O | done |
| P1-11 | 油价 state 无形状/版本校验，损坏即每日失败 | oilprice/watch.ts:95-104,26-36 | O | done |
| P1-12 | 城市→省份映射覆盖不足 | oilprice/provider.ts:42-55,134,189-194 | O | done |

### P2（22 项全 done）

| # | 问题 | 文件:行 | 负责 | 状态 |
|---|---|---|---|---|
| P2-01 | engines >=22.5 与 node:sqlite flag 事实不符 | package.json:8; README.md:42,203 | 主 | done |
| P2-02 | 密钥备份文件未忽略 | .gitignore | 主 | done |
| P2-03 | npm audit 8 漏洞（fast-uri/hono/uuid） | package-lock | 主 | done |
| P2-04 | weather: days 未 .int() | weather/index.ts:210-213 | W | done |
| P2-05 | weather: inferred 分支无 try/catch | weather/index.ts:134-140 | W | done |
| P2-06 | weather: daily brief identity 不含城市 | weather/index.ts:101 | W | done |
| P2-07 | weather: precip NaN / "0mm" 噪音 | weather/provider.ts:167 | W | done |
| P2-08 | httpJson timer 未在 finally 清理 | core/http.ts:10-15 | W | done |
| P2-09 | byWeekday 非法字符串静默丢弃 | schedule/index.ts:24; service.ts:243-246 | S | done |
| P2-10 | 重复 reminder id 静默折叠 | schedule/service.ts:116-120 | S | done |
| P2-11 | until 格式/count 与 until 互斥未校验 | schedule/index.ts:26-27; service.ts:248 | S | done |
| P2-12 | update 对 recurrence 浅合并丢字段 | schedule/service.ts:480-500 | S | done |
| P2-13 | schedule 默认时区硬编码 Asia/Shanghai | schedule/service.ts:23,168 | S | done |
| P2-14 | title/note 无长度上限 | schedule/index.ts:33-34 | S | done |
| P2-15 | oilprice: code "200" 字符串被拒 | oilprice/provider.ts:146 | O | done |
| P2-16 | oilprice: 精确到分校验过严（±1 分容差） | oilprice/provider.ts:111-113 | O | done |
| P2-17 | oilprice: hoursUntil 浮点长尾 | oilprice/schedule.ts:38 | O | done |
| P2-18 | oilprice: TianAPI 异常全量吞掉诊断丢失 | oilprice/provider.ts:136-172 | O | done |
| P2-19 | oilprice: nextWindowDate 未用于交叉校验 | oilprice/provider.ts:163 | O | done |
| P2-20 | tick 无重叠保护 | scheduler.ts:279-287 | 主 | done |
| P2-21 | 第二 scheduler 未获租约静默 exit(0) | scheduler.ts:225,296-304 | 主 | done |
| P2-22 | legacyId 依赖运算符优先级可读性差 | core/notifier.ts:151-153 | 主 | done |

## 二次审查（对抗性复审，dba9d96）

修复 commit `b274d08` 之后，用 3 个全新 flash 审查代理对全部 diff 做了对抗性复审（只读），
发现并修复：

| 级别 | 问题 | 修复 |
|---|---|---|
| P0 | sanitizeRecurrence 丢弃 leapMonthPolicy，农历闰月日程读取侧按普通月算日期 | 保留 JSON 中的合法策略 + 以 `leap_month_policy` 列值为权威覆盖；回归测试 |
| P1 | ±1 分容差只在 provider 放宽，watch.ts:117 仍严格比对 → 官方结果静默丢弃 | watch 消费端同口径放宽；端到端发布测试 + 2 分拒绝测试 |
| P1 | 数字型 code 绕过和风业务错误码检查（fetchAlerts 静默为空） | 三处改为 `String(r.code) !== "200"` 统一比较 |
| P1 | legacy 行同时含 count+until 时任何 update 被互斥校验误伤 | hydration 侧保留 count 丢弃 until；回归测试 |
| P1 | 格式合法但日历非法的 until（2099-02-30）仍打挂读取路径 | sanitize 用 luxon 校验日历合法性，非法丢弃；回归测试 |
| P2 | daily-brief 键加城市后升级当天与旧键重复推送 | runDailyWeatherBrief 传 legacy 键走既有改键复用机制；回归测试 |
| P2 | fallback 重新入队重置 request_generation=1，可能与漂移前 a1 请求号撞号 | 改为 `request_generation + 1` |
| P2 | hoursUntil 四舍五入使 `hoursUntil < 40` 阈值漂移（39.96→40 漏发 advance） | 逻辑用精确值，仅工具展示层取整 |
| P2 | isValidOilPriceState 拒绝缺 schemaVersion 的完整旧 state → 升级后吞掉在途窗口结果 | schemaVersion 允许缺失（其余字段严格校验）；迁移测试 |
| P2 | 旧库脏位置数据（空 city/越界坐标）继续毒化天气/油价链路 | currentLocation 读取侧 safeParse 校验 + env 坐标校验 |
| P2 | resolveLocation / qweatherGeo 的兜底坐标未校验（与 location.detect 不对称） | 两处补有限性/范围校验，qweatherGeo 拒绝垃圾坐标入缓存 |
| P2 | hydration 后重复 reminder id 静默折叠 | sanitizeReminders 重复 id 回退为位置 id；回归测试 |
| P2 | nearestWindowDeviationDays 遇表内非法条目得 NaN 禁用告警 | 循环内 Number.isFinite 防御 |
| P2 | 测试缺口（边界坐标/NaN、迁移场景） | location 边界接受测试、oilprice 迁移测试 |

接受并记录（不改）：redactUrl 对非 URL 输入原样返回（当前无调用方）；catch-up 滞后无上限
（targetAt 仍在未来即补发是有意语义）；stale-snapshot 跳过日志可能刷屏（并发持续时）。

## 三次审查（Codex CLI 独立对抗性复审，f413779）

`dba9d96` 全部落地后，用 Codex CLI（独立第三方审查员）做只读静态复审：先读本文档，
再逐项核对修复代码落点，并寻找回归/遗漏。发现 3 P2 + 1 P3，待 DeepSeek Harness 修复。

| 级别 | 问题 | 位置 | 状态 |
|---|---|---|---|
| P2 | sanitizeReminders 自动生成的 `reminder-N` id 未加入去重集合：旧脏数据可造出两条同 id 提醒，第二条被 occurrence key 去重静默折叠丢失 | schedule/service.ts:102-105 | done（N1：生成 id 占位去重集合，冲突时递增回退） |
| P2 | cachedGeo 只校验新写入、不校验旧缓存：升级前已写入的脏坐标（越界/NaN）7 天内读取时原样返回，继续毒化天气链路 | weather/provider.ts:95-106 | done（N2：读取侧与新写入同一校验口径，非法缓存立即清除并重新查询，同时剥离返回的 ts 元数据） |
| P2 | P1-07 hydration 防护只覆盖 JSON 字段：timezone/date/time/calendar 标量列损坏的旧行仍会让 listSchedules/getSchedule 整体抛错（poison 行未完全关闭） | schedule/service.ts:480-496,130-134 | done（N4/D2-A：标量列校验兜底 + 派生值 try/catch） |
| P3 | leapMonthPolicy `both`/`prefer-leap` 被类型与 sanitize 保留但 solarForLunar 未实现语义（仅 leap 特殊处理）；正常入口 schema 只开放 normal/leap 暂不受影响，建议入口拒绝或后续版本实现 | schedule/service.ts:278-287 | done（N3/D1-A：类型收窄为 normal/leap，输入路径拒绝，legacy 读取归一为 normal） |

### 三次审查遗留（P3，d571a60）

修复 commit `f413779` 后第三轮复审（Codex CLI）发现 3 项 P3，不阻塞但建议收尾：

| # | 问题 | 位置 | 状态 |
|---|---|---|---|
| P3-1 | 进度日志「按任务红线未 commit」与实际提交 `f413779` 矛盾，真相源误导 | docs/repair-plan.md 进度日志 | done（2026-08-14 主代理修正表述） |
| P3-2 | N4 派生值 try/catch 边界偏宽：同时包住 `fromUtc` 与 `findOccurrence`，后者未来出现真逻辑 bug 会被静默吞掉，日程不触发且无日志 | schedule/service.ts:546-553 | done（fromUtc 与 findOccurrence 分离；findOccurrence 非预期异常 console.error 并保留 nextRunAt；hydrateRow 增加可注入 findImpl 供测试） |
| P3-3 | N4 只校验四标量列：`lunar_month`/`lunar_day`/`deadline_offset_minutes`/`version` 仍直接 `Number(...)`，NaN 可致 `nextReminderTiming` 返回 null → 日程静默停用、提醒丢失 | schedule/service.ts:531-540,399-400 | done（finiteIntOrUndefined 校验整数/范围，非法按默认值兜底） |

## 第四轮审查新发现（3076579）

| # | 级别 | 问题 | 位置 | 状态 |
|---|---|---|---|---|
| P2-1 | P2 | hydration 把越界/非整数 `version` 统一归为 1（service.ts:551），但 scheduler 用 DB 原始 `fresh.version` 与 `item.version` 严格比较（scheduler.ts:125-133）并按 item.version 更新（180-188）→ `version=0` 等脏行永远判为 stale snapshot：不发布、不推进，提醒持续丢失；`updateSchedule` 版本冲突。正常 version≥1 不受影响 | schedule/service.ts:551 vs scheduler.ts:125-133,180-188 | done（共享 normalizeVersion 口径：scheduler 比较归一化值、WHERE 用原始列值、写回归一化值自愈；updateSchedule WHERE 同样用原始列值） |
| P3-1 | P3 | `findOccurrence` 若持续抛错，hydration 每 tick 记日志（service.ts:570-573）+ scheduler 捕获抛回（204-209）+ tick 失败再记（306-307）→ 同一行双日志刷屏。不产生重复提醒（occurrences/通知去重仍在），但持久 bug 下运营噪声大 | schedule/service.ts:570-573, scheduler.ts:204-209,306-307 | done（logHydrationError 5 分钟窗口去重，Map 容量阈值清扫过期条目；scheduler tick 级日志保留） |

## 第五轮审查新发现（5807d93，已全部修复）

| # | 级别 | 问题 | 位置 | 状态 |
|---|---|---|---|---|
| N1 | P2 | `updateSchedule` 乐观锁 TOCTOU：`getSchedule`（T1）读整行与 `rawVersion`（T2）单独读是两次独立查询，MCP 与 scheduler 独立进程，T1→T2 窗口内并发版本推进会使 WHERE 用新版本、写旧数据，覆盖并发更新、丢失 next_run_at/enabled/status 推进 | schedule/service.ts:703,706,761 | done（合并为单条 SELECT * 快照，插桩测试断言仅 1 次读取） |
| N2 | P3 | NULL version 未纳入自愈口径：schema 为 NOT NULL DEFAULT 1 正常不会出现，但手工损坏/外部写入 NULL 时，scheduler 比较通过发布一次后 `WHERE version = NULL` 永不命中 → 永久卡住、updateSchedule 永远冲突；测试只覆盖 0/-1/1.5 | schedule/service.ts:495, scheduler.ts:130,192, service.ts:709 | done（WHERE 改用 `version IS ?` 匹配 NULL，写回归一化值自愈；测试用 CTAS 重建表模拟 NULL） |
| N3 | P3 | 日志去重 Map 非硬上限：256 阈值只清过期条目，全活跃时仍继续 set（测试已见 size=300），5 分钟窗口内大量不同 key 持续失败时内存无界增长 | schedule/service.ts:511,516 | done（清理过期后仍达阈值则淘汰最旧条目，Map 有硬上限恒 ≤256） |
| N4 | P3 | 测试覆盖/隔离缺口：脏版本调度测试未断言 DB version 自愈值（若改成"推进但不修版本"测试仍绿）；模块级 hydrationErrorLastLoggedAt 测试前后未重置，依赖执行顺序，抗重构性弱 | schedule-scheduler-deadline.test.ts:316, profile-schedule.test.ts:2249, service.ts:505 | done（补 version=2 自愈断言；新增测试专用 resetHydrationErrorLog，日志测试前后重置，两文件可独立运行） |

## 进度日志（新条目加在最上面）

- 2026-08-14 N1-N4 收官修复完成（按 ~/artifacts/documents/life-assistant/dsh-fix-prompt-p6.md，
  TDD 先红后绿）：N1 updateSchedule 单条 SELECT * 快照消除 TOCTOU；N2 乐观锁 WHERE
  改用 version IS ? 匹配 NULL 并自愈；N3 日志 Map 淘汰最旧条目实现硬上限（恒 ≤256）；
  N4 补 version 自愈断言 + resetHydrationErrorLog 测试隔离。新增 4 个回归测试
  （profile-schedule ×3 + schedule-scheduler-deadline ×1），npm run build 零错误、
  npm test 222/222 全绿，两测试文件可独立运行。代码提交 `5807d93`。
- 2026-08-14 第五轮复审（Codex CLI）完成：P2-1/P3-1 原始目标关闭（0/-1/1.5 脏版本
  不再 stale、hydration 日志去重生效、测试非假绿、文档自洽）；无 P0/P1。新发现
  1 P2 + 3 P3（见「第五轮审查新发现」表）：N1 updateSchedule 乐观锁 TOCTOU 竞态、
  N2 NULL version 未纳入自愈口径、N3 日志 Map 无硬上限、N4 测试覆盖/隔离缺口。
  待 DeepSeek Harness 修复。独立验证：218/218、build 零错误、diff-check 干净。
- 2026-08-14 P2-1/P3-1 修复完成（按 ~/artifacts/documents/life-assistant/dsh-fix-prompt-p5.md，
  TDD 先红后绿）：P2-1 共享 normalizeVersion 口径（scheduler 比较归一化值、WHERE 原始列值、
  写回归一化值自愈；updateSchedule 同样处理）；P3-1 logHydrationError 5 分钟窗口去重 +
  Map 容量阈值清扫过期条目。新增 4 个回归测试（profile-schedule ×3 +
  schedule-scheduler-deadline ×1），npm run build 零错误、npm test 218/218 全绿。
  代码提交 `3076579`。
- 2026-08-14 第四轮复审（Codex CLI）完成：P3-2/P3-3 核心修复真实落地（try/catch
  分离、finiteIntOrUndefined、findImpl 注入默认兼容、回归测试非假绿、文档自洽）；
  无 P0/P1。新发现 1 P2 + 1 P3（见「第四轮审查新发现」表）：version 归一化口径
  未闭环 → version=0 脏行永久 stale、提醒持续丢失；hydration 错误日志刷屏。
  待 DeepSeek Harness 修复。独立验证：214/214、build 零错误、diff-check 干净。
- 2026-08-14 P3-2/P3-3 收尾硬化完成（按 ~/artifacts/documents/life-assistant/dsh-fix-prompt-p3.md，
  TDD 先红后绿）：P3-2 fromUtc 与 findOccurrence 分离，后者非预期异常 console.error
  且保留 nextRunAt（hydrateRow 增加可选 findImpl 注入点）；P3-3 四数值列
  finiteIntOrUndefined 校验兜底（lunar_month 1-12 / lunar_day 1-30 /
  deadline_offset_minutes 0-525600 / version ≥1 缺省 1）。新增 3 个回归测试
  （profile-schedule ×2 + schedule-scheduler-deadline ×1），npm run build 零错误、
  npm test 214/214 全绿。代码提交 `d571a60`。
- 2026-08-14 N1-N4 修复完成（按 ~/artifacts/documents/life-assistant/dsh-fix-prompt-n1n4.md，
  TDD 先红后绿）：N1 自动 id 占位去重集合；N2 cachedGeo 读取侧校验 + 清除脏缓存 + 剥离 ts；
  N3/D1-A 类型收窄 normal/leap、输入拒绝、hydration 归一；N4/D2-A 标量列校验兜底。
  新增 7 个回归测试（tests/weather-geo-cache.test.ts ×3 + profile-schedule ×4），
  npm run build 零错误、npm test 211/211 全绿。已提交 `f413779`。
- 2026-08-14 三次审查（Codex CLI 独立对抗性复审）完成：静态只读复审全量修复项，关键
  语义均有代码证据、总体质量高；新发现 3 P2 + 1 P3（见「三次审查」表），待
  DeepSeek Harness 修复。独立验证：git status 干净、npm run build 零错误、
  npm test 204/204。报告存档 ~/artifacts/documents/life-assistant/codex-adversarial-review-20260814.md。
- 2026-08-13 二次对抗性复审（3 路 flash 代理）完成：发现 1 P0 + 4 P1 + 9 P2（见
  「二次审查」表），全部修复并补 8 个回归测试（lunar 闰月 hydration、legacy count+until
  更新、日历非法 until、重复 reminder id、daily-brief legacy 改键、±1 分端到端发布、
  无 schemaVersion 迁移、坐标边界/NaN）。最终验证：npm run build 零错误、
  npm test 204/204 全绿。代码提交 `dba9d96`（其 commit 消息写作 "3 P1"，实际为 4 P1，
  以本文档为准），文档提交 `da62c42`。
- 2026-08-13 全部 P1（12 项）与 P2-01..P2-22 完成：主代理修复 notifier/scheduler/package/gitignore；
  三路 flash 子代理（workflow，deepseek-v4-flash）修复 weather/oilprice/schedule 分区；
  主代理集成审查修正两处：O8 窗口交叉校验改为"最近窗口日±1 天"（消除每日误告警）、
  sanitizeRecurrence 对 until/byWeekday/byMonthDay/count 补类型强制。npm audit fix 收敛
  fast-uri(3.1.5)+hono(4.13.2)；残留 2 个 moderate 为 node-cron→uuid 8.3.2（v3/v5/v6 buffer
  路径，node-cron 实际只用 v4，不可利用；修复需 node-cron 4 大版本，暂缓）。全部验证：
  npm run build 零错误、npm test 196/196 全绿（基线 171 + 新增 25）。文档同步：
  README Node >= 22.13、architecture.md 投递恢复/简报键/补发语义。
  已提交本地 commit `b274d08`。
- 2026-08-13 计划定稿：P1×12 + P2×22 选做清单、文件分区、验证命令。开始主代理分区修复（notifier/scheduler/package/gitignore）。
