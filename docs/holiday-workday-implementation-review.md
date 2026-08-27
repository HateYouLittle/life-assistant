# 交付文档：中国大陆法定节假日/工作日功能（供第三方代码复审）

> **已归档（2026-08-15，交付时 HEAD `d942c3a`）**：本文是该功能的实现与七轮复审过程记录，文中的文件行数、测试数量、变更范围都是当时快照，不再随代码更新。T1-T4 / H / K / M / N 系列批次标记仍被 [architecture.md](architecture.md) 第 7 节行内引用，故保留作编号出处；节假日现行语义一律以 architecture.md 与 README 为准。

- 状态：实现完成；Codex 六轮复审发现的缺陷均已修复，第七轮最终验收通过
- 测试基线：222（改动前）→ **333（第六轮修复后，全绿）**
- 变更范围：16 个既有文件修改 + 12 个新文件（3 源码 + 4 测试 + 4 fixture + 本文档），既有文件含 `docs/repair-plan.md`
- 目标读者：独立代码复审人员（无需了解本项目历史）

---

## 1. 任务背景与已确认需求

在日程模块中加入中国大陆法定节假日/工作日的历法能力，围绕节假日与工作日展开日程场景。需求确认要点：

| # | 需求 | 确认结论 |
|---|---|---|
| 1 | 「法定工作日」语义 | 周一至周五 − 法定节假日 + 调休上班的周末 |
| 2 | 「距离下次放假还有多久」 | 返回下一连休期：节日名、起止日期、倒计时天数，并**一并给出调休上班日** |
| 3 | 数据源 | 由实现方选定稳定数据源 + 兜底方案（见 §4.1） |
| 4 | 无数据区间 | **暂不触发**，绝不用「周一至周五」普通周历猜测 |
| 5 | 节假日提醒 | 同时支持「仅法定节假日」提醒规则 |
| — | 硬约束 | 节假日安排不能依赖用户提供，程序每年特定时间自动获取下一年安排 |

典型场景：
- 「每个法定工作日早上 9 点提醒」→ `schedule.create` 传 `recurrence: "workday"`、`time: "09:00"`；
- 「距离下次放假还有多久」→ Agent 调用 `holiday.next`。

## 2. 交付结果概览

- 新增模块 `holiday`（3 个工具 + 1 个 refresh 工具 + 1 个每日 job + scheduler 启动引导）；
- 日程 recurrence 新增 `workday` / `holiday` 两种频率；
- SQLite schema v3 → v4（additive 迁移，新增 2 张表）；
- MCP 工具总数 15 → 19；
- 新增 111 个测试（功能实现 54 + 六轮复审修复回归 57），全量 333/333 通过；
- 文档同步更新：README、`docs/architecture.md`、`skill/SKILL.md`、`.env.example`。

### 复审后修复记录（第一批，2026-08-15）

| 编号 | 级别 | 缺陷 | 修复内容 | 新增回归测试数 |
|---|---|---|---|---|
| T1 | P1 | `fetchHolidayYear` 不核对请求年份，错年数据可被接受 | `parseDataset` 后强制 `dataset.year === 请求 year`，不一致按该源失败继续走兜底链 | 2 |
| T2 | P1 | 历史年份（2004–2007 四节日、总数 <20）与跨年元旦被双重误拒 | 必现节日与总数下限按年份口径（2008 前四节日、≥8 天）；仅放行「上一年 12/20 之后的元旦」跨年日期 | 5（含跨年入库集成测试） |
| T3 | P2 | 日期只做格式正则，`2025-02-30` 可通过 | 每个日期用 luxon 做真实日历校验（`isValid` + `toISODate()` 回写比对） | 2 |
| T4 | P2 | 创建/更新/reconcile 不判「真正耗尽」，僵尸态永远卡在 active+停用 | 三处均调用 `holidayAwareRuleFinished`：until/count 耗尽 → `completed`；仅数据缺失 → 保持 active；archived 不被覆盖 | 6 |

合计新增回归测试 15 个；P3 项（5 条）留待下一批。

### 复审后修复记录（第二批，2026-08-15）

| 编号 | 级别 | 缺陷 | 修复内容 | 新增回归测试数 |
|---|---|---|---|---|
| H1 | P1 | `ingestHolidayYear` 按标题年整年删除，后抓相邻上一年会清掉跨年行 | 删除改为按数据集实际日期范围（`date BETWEEN min AND max`）；相邻标题年范围互不重叠，跨年行天然保留 | 3 |
| H2 | P2 | `holidayYearView`/`nextHoliday` 不跨年合并，元旦边界起止/天数错误 | 视图查询改为标题年日期范围（上年 12/20 至当年 12/31）；`nextHoliday` 跳过上一年视图中被截断的 12/31 结束段（范围边界后由 K1 收窄，截断段跳过逻辑随 K1 删除） | 3 |
| H3 | P2 | 2004 fixture 是合成数据；2008 前 `minHolidayDays=8` 过松 | fixture 重写为真实黄金周（22 holiday + 6 workday）；休假日总数下限统一为 20 | 1 |
| H4 | P3 | T3 缺闰年边界断言 | 补 `2025-02-29` 拒绝、`2024-02-29` 接受断言 | 1 |
| H5 | P3 | chinese-days 唯一自然年行为未锁定 | 补混合年数据的解析拒绝与抓取链错误聚合测试 | 2 |

合计新增回归测试 10 个。剩余 P3（papers 域名白名单、ingest 入口自校验、统计日志、timezone 兜底、v4 迁移测试、固定年份注入）留待后续批次。

### 复审后修复记录（第三批，2026-08-15）

| 编号 | 级别 | 缺陷 | 修复内容 | 新增回归测试数 |
|---|---|---|---|---|
| K1 | P2 | 视图 maxDate 越界拉入下一标题年 12 月行，同名元旦段补班互相串染 | 视图范围收窄为 `[year-1-12-20, year-12-19]`；补班日按「最近同名段 + 10 天窗口」关联 | 3 |
| K2 | P2 | `is_workday`/`list` 只按自然年补抓，12/20–12/31 冷启动答错 | 新增 `ensureDayCoverage`（12 月下旬优先确保下一年标题年）与 `ensureYearForView`（list 只确保标题年） | 3 |
| K3 | P3 | `nextHoliday` 当年未 ready、下一年已 ready 时提前 unknown | 跨年窗口内下一年视图 ready 时继续扫描下一年，双缺仍 unknown | 2 |

合计新增回归测试 8 个。剩余 P3（papers 域名白名单、ingest 入口自校验、统计日志、timezone 兜底、v4 迁移测试、固定年份注入）留待后续批次。

### 复审后修复记录（第四批，2026-08-15）

| 编号 | 级别 | 缺陷 | 修复内容 | 新增回归测试数 |
|---|---|---|---|---|
| M1 | P2 | schedule 对 12/20–12/31 日期按自然年判 ready，跨年日期按周历猜测 | 新增日期级覆盖判断 `isDateCoveredByHolidayData`；occurrence 扫描与 count 回溯均改用标题年覆盖，未覆盖返回 null | 4 |
| M2 | P2 | `ensureDayCoverage` 回退自然年成功后不确认目标行，仍可能周历猜测 | 权威标题年 ready 即覆盖；自然年兜底必须命中 holiday/workday 行，否则抛错 | 3 |
| M3 | P3 | `readHolidayYear` 按自然年计数，跨年标题年少计 3 天 | 查询改为标题年日期范围 `[year-1-12-20, year-12-19]`，与视图语义一致 | 3 |

合计新增回归测试 10 个。剩余 P3（papers 域名白名单、ingest 入口自校验、统计日志、timezone 兜底、v4 迁移测试、固定年份注入）留待后续批次统一评估。

### 复审后修复记录（第五批，2026-08-15）

| 编号 | 级别 | 缺陷 | 修复内容 | 新增回归测试数 |
|---|---|---|---|---|
| N1 | P2 | chinese-days 的 year+1 不含上一年 12 月行，被误判为完整跨年覆盖 | `isDateCoveredByHolidayData` 的 year+1 分支仅认 `source === "holiday-cn"`；chinese-days 走自然年兜底命中行 | 4（calendar 3 + schedule 1） |
| N2 | P2 | `ensureDayCoverage` 对 chinese-days 的 year+1 直接 return，跨年日期仍周历猜测 | year+1 仅 holiday-cn 权威覆盖；chinese-days 继续回退自然年并做行命中确认 | 2 |
| N3 | P2 | chinese-days 标题年缺上一年 12 月行时，视图/nextHoliday/list 静默截断 | 视图层方案 B：缺口返回 undefined → unknown；list 入口方案 A：`ensureYearForView` 自动补齐 year-1 | 5（calendar 3 + module 2） |

合计新增回归测试 11 个。剩余 P3（papers 域名白名单、ingest 入口自校验、统计日志、timezone 兜底、v4 迁移测试、固定年份注入）留待后续批次统一评估。

### 复审后修复记录（第六批，2026-08-15，收官批）

| 编号 | 级别 | 缺陷 | 修复内容 | 新增回归测试数 |
|---|---|---|---|---|
| N4 | P2 | chinese-days 标题年 + holiday-cn 上一自然年 ready 时，视图仍静默截断元旦 | 视图缺口与 list 补齐条件改为按 source 对称判断：只有 year-1 为 chinese-days 才能提供 12 月下旬跨年行；否则视图 unknown / list 报错，不覆盖既有数据 | 3（calendar 1 + module 2） |
| P3-顺手 | P3 | 关键 schedule 测试用 `DateTime.now().year`，存在年份漂移风险 | `tests/schedule-holiday.test.ts` 改为固定常量 `FIXED_TEST_YEAR = 2026`（9 处替换），断言语义不变 | 0（既有 26 个用例） |

合计新增回归测试 3 个。其余遗留 P3（papers 域名白名单、ingest 入口自校验、统计日志、timezone 兜底、v4 迁移测试）留待主代理在收官时统一评估。

> **最终验收（2026-08-15，第七轮 Codex 独立复审）**：可以无保留验收（收官）。
> 六批修复（T1–T4 / H1–H5 / K1–K3 / M1–M3 / N1–N3 / N4）叠加后零 P0/P1/P2，
> 核心保证「无数据年份绝不按普通周历猜测」在所有查询与 schedule 路径生效；
> 全量测试 333/333 全绿、build 零错误、diff-check 干净。遗留 P3 均为测试维护/
> 覆盖问题，记入后续版本，不阻塞提交。

### 新增 MCP 工具

| 工具 | 语义 |
|---|---|
| `holiday.next` | 下一个/当前连休期：`ongoing/upcoming/unknown`、节日名、起止日期、倒计时天数、剩余天数、调休上班日 |
| `holiday.list` | 某年全部连休期 + 全部调休上班日；缺数据时自动补齐 |
| `holiday.is_workday` | 判断某天类型：`holiday / workday / weekday / weekend`，含节日名与补班说明 |
| `holiday.refresh` | 手动补抓指定年份（`force` 跳过冷却），数据仍来自官方源，抓取后重算受影响日程 |

## 3. 架构与数据流

```text
              ┌────────────────────────────────────────────────┐
              │ scheduler（唯一常驻）                           │
              │  onStart: 启动时引导确保当年节假日数据           │
              │  holiday.refresh_calendar（每日 02:00 Asia/Shanghai）│
              │    确保当年 + 10月起尝试下一年                   │
              │    成功后 reconcileHolidaySchedules()           │
              └───────────────┬────────────────────────────────┘
                              │ 抓取/校验/按日期范围入库
                              ▼
   holiday-cn (jsDelivr → raw 镜像)  →  chinese-days (npm/jsDelivr 兜底)
                              │
                              ▼
        SQLite: cn_holiday_days + cn_holiday_year_meta（共享数据）
                              ▲
              ┌───────────────┴───────────────┐
              │ MCP 查询面（每 Profile 一进程）│
              │ holiday.next（只读）           │
              │ holiday.list / is_workday /    │
              │ refresh（缺数据时冷却补齐）     │
              └───────────────┬───────────────┘
                              ▼
        schedule service: findOccurrence(workday/holiday)
                              │
                              ▼
        scheduler 每分钟日程扫描 → 通知 outbox（既有链路不变）
```

关键边界：
- 查询面不跑 cron；自动抓取的权威路径在 scheduler；
- 节假日数据为共享数据，不带 `profile_id`；日程仍严格 Profile 私有；
- 模块只产生事件，不直绑平台（遵循既有演进原则）。

## 4. 关键设计决策与理由

### 4.1 数据源与兜底（已实测）

| 层级 | 数据源 | URL | 说明 |
|---|---|---|---|
| 主源 | [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT） | `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json` | 每日自动抓取国务院公告，含 `papers`（官方通知原文链接）；实测 2025/2026 均有数据 |
| 主源镜像 | 同上，raw.githubusercontent | `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json` | 同一数据集的可用性兜底 |
| 独立兜底 | [vsme/chinese-days](https://github.com/vsme/chinese-days)（MIT） | `https://cdn.jsdelivr.net/npm/chinese-days/dist/years/{year}.json` | 不同维护者与生成方式；npm CDN 稳定性好；实测 2025/2026 均有数据 |

- 被排除：timor.tech —— 实测被 Cloudflare 挑战页拦截，不适合程序化抓取。
- **防预估污染门槛（重要）**：对「下一年」（year > 当前年）的抓取，只允许主源 holiday-cn 且必须携带非空 `papers`（国务院已正式发布的证明）；独立兜底源只用于当年与历史年份。这避免某些数据源提前放入的非官方推测日期被当成权威安排。
- 双格式归一化为内部 `HolidayDay { date, year, dayType: "holiday"|"workday", name }`。

### 4.2 入库前结构校验（全过才写）

0. **数据集年份必须与抓取请求年份一致**（fetch 层强制，T1）；
1. 日期为规范 `YYYY-MM-DD` 且是**真实存在的日历日**（luxon 校验，拒绝 `2025-02-30` 等，T3）；年份归属为同自然年，仅「上一年 12/20 之后的元旦」允许跨年；无重复、无「既是休假日又是上班日」；
2. 法定节日按年份口径齐全：**2008 年起七个**（元旦/春节/清明/劳动节/端午/中秋/国庆）；**2004–2007 仅四个**（元旦/春节/劳动节/国庆）；
3. 调休上班日必须落在周六/周日；
4. 每个节日的休假日必须落在该节日的历史合理日期窗口（如劳动节 4/20–5/12）；
5. 每个节日名的休假日按名字分组后连续段数量 ≤ 4；
6. 全年休假日总数 20–45（2004 起统一口径；2004 黄金周真实值 22），调休上班日 ≤ 12；已知临时附加假日（如 2015 抗战胜利 70 周年纪念日）单独校验窗口与成对性；
7. 次年额外门槛见 4.1。

校验失败保留旧数据并记录 `last_attempt_at/last_error`。

### 4.3 年份级可用性标记（「无数据区间」的载体）

`cn_holiday_year_meta.status='ready'` 的年份才参与日期分类。workday/holiday occurrence 按**日期级标题年覆盖**判断（M1/N1）：12/20–12/31 日期仅当 year+1 为 holiday-cn 标题年且 ready 时视为完整覆盖；否则需自然年 ready 且该日期命中权威行；其余日期看自然年标题年是否 ready。未覆盖**立即返回 null**，不跨越缺失区间继续向后猜。这是「无数据区间暂不触发」的实现基础。

### 4.4 自动获取机制

- **scheduler 启动引导**：`AssistantModule` 新增可选 `onStart?: () => Promise<void>`（向后兼容，异常隔离）。scheduler 拿到租约后调用，holiday 模块借此确保当年数据，避免安装当天等到深夜 cron；
- **每日 job**：`holiday.refresh_calendar`，cron 默认 `0 2 * * *`（`HOLIDAY_REFRESH_CRON` 可配，时区固定 Asia/Shanghai）。每天确保当年数据；**每年 10 月起额外尝试下一年**；
- **失败冷却**：6 小时，避免反复打源；失败不阻断其它 job；
- **幂等**：同年同源同 payload_hash 不重写；每次 job 末尾执行日程重算。

### 4.5 schedule 集成

- `recurrence.frequency` 新增 `"workday" | "holiday"`；
- 约束（输入校验）：仅公历、仅 `Asia/Shanghai` 时区（避免「美国时区的中国工作日」歧义）、不支持 `interval/byWeekday/byMonthDay`、`count` 与 `until` 仍互斥；
- occurrence 计算：从 `max(from 日, 锚点日)` 起按天扫描；命中即返回，`until` 到界或候选日期未被标题年数据覆盖（M1 日期级判断）返回 null；`count` 会回溯统计锚点至今已消耗的 occurrence（覆盖缺失时无法确定序号 → null）；
- **数据入库后的重算**：`reconcileHolidaySchedules()` 扫描所有 Profile 的 workday/holiday 日程并重算 `next_run_at` 与派生状态：
  - 有新触发时间 → `enabled=1`；
  - 无数据暂不可算 → `enabled=0`、**status 保持 active**，等数据入库后复活；
  - `until/count` 真正耗尽 → `status='completed'`（终态）；
  - 更新走既有乐观锁（`WHERE version IS ?`），冲突放弃本轮；派生状态重算**不推进 version**；
- **创建/更新同语义（T4）**：workday/holiday 在 `nextRunAt` 为空时调用 `holidayAwareRuleFinished`——真正耗尽落 `completed`，仅数据缺失保持 `active`；`archived` 等其他状态不被覆盖；
- `processDue` 调整：workday/holiday 无 next run 时，`until/count` 真正耗尽才 `completed`，否则保持 active 停用待复活。

### 4.6 语义精确定义

| 项 | 定义 |
|---|---|
| 法定工作日 | 周一至周五 − 法定节假日 + 调休上班周末 |
| `workday` occurrence | 每个法定工作日的 `time`（Asia/Shanghai） |
| `holiday` occurrence | 每个法定节假日休假日（含假期内的周末）的 `time`，不含普通周末 |
| 「下次放假」 | 结束日 ≥ 查询日的第一个连休期；查询日落在期内返回 `ongoing`（countdown=0 + 剩余天数） |
| 无数据年份 | 不触发；日程 active 但停用，数据到位后自动恢复 |

## 5. 数据模型（schema v3 → v4）

```sql
CREATE TABLE IF NOT EXISTS cn_holiday_days (
  date       TEXT PRIMARY KEY,          -- YYYY-MM-DD（Asia/Shanghai 口径）
  year       INTEGER NOT NULL,
  day_type   TEXT NOT NULL CHECK(day_type IN ('holiday','workday')),
  name       TEXT NOT NULL,             -- 元旦/春节/清明节/…
  source     TEXT NOT NULL,             -- holiday-cn | chinese-days
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cn_holiday_days_year ON cn_holiday_days(year);

CREATE TABLE IF NOT EXISTS cn_holiday_year_meta (
  year            INTEGER PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'ready',  -- ready | failed
  source          TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  last_attempt_at TEXT,
  last_error      TEXT
);
```

- 入库在单个 `BEGIN IMMEDIATE` 事务中完成（按数据集覆盖日期范围 delete → insert → upsert meta），不会出现部分数据；按日期范围删除而非按标题年整年删除，避免清掉相邻标题年写入的跨年行（H1）。
- 迁移是 addtive：旧表/旧行不动，`schema_meta.version` 由 `'3'` 更新为 `'4'`；迁移测试已同步更新并验证幂等与 `foreign_key_check`。

## 6. 变更文件清单

### 新增源码

| 文件 | 职责 |
|---|---|
| `src/modules/holiday/provider.ts` (373 行) | 双源 URL、两格式解析归一、结构校验、按序抓取、次年官方门槛、请求年份核对 |
| `src/modules/holiday/calendar.ts` (471 行) | 事务入库、ready 判定、日期分类、连休期分组、nextHoliday、ensure/refresh（冷却） |
| `src/modules/holiday/index.ts` (248 行) | 模块注册：4 tools + refresh job + onStart；工具懒补齐门控 |

### 修改源码

| 文件 | 改动 |
|---|---|
| `src/core/database.ts` | schema v4：新增 2 张表 + 索引；version 3→4 |
| `src/core/registry.ts` | `AssistantModule` 增加可选 `onStart` |
| `src/scheduler.ts` | 租约取得后调用各模块 `onStart`；processDue 对 workday/holiday 的 status 转移 |
| `src/modules/index.ts` | 注册 holiday 模块 |
| `src/modules/schedule/types.ts` | `Frequency` 增加 `workday` / `holiday` |
| `src/modules/schedule/service.ts` | 频率校验、历法感知 occurrence、until/count、`reconcileHolidaySchedules`、创建/更新时无数据停用 |
| `src/modules/schedule/index.ts` | Zod schema 与工具描述更新 |
| `src/config.ts` | `cron.holidayRefresh`（env `HOLIDAY_REFRESH_CRON`，默认 `0 2 * * *`） |

### 测试与 fixture

| 文件 | 用例数 | 覆盖重点 |
|---|---|---|
| `tests/holiday-provider.test.ts` | 28 | 两格式解析、真实 fixture 校验、三级兜底顺序、次年官方门槛、非法数据拒绝；**复审回归：请求年份核对、2004/2019 历史形态、真实日历日期、闰年边界、chinese-days 混合年行为** |
| `tests/holiday-calendar.test.ts` | 37 | 入库/幂等/替换、dayInfo 分类、连休期分组、nextHoliday 三态、冷却与重试、10 月窗口；**复审回归：跨年行不丢失、标题年视图跨年合并、视图不越界、同名段补班不串染、非对称 ready、readHolidayYear 标题年计数、chinese-days 来源覆盖、视图缺口（含混合源）** |
| `tests/schedule-holiday.test.ts` | 26 | 频率约束、跳过节假日/补班日、until/count、无数据停发、远未来锚点、reconcile 跨 Profile、processDue 状态；**复审回归：completed 终态、archived 保护、跨年窗口按标题年覆盖（holiday-cn 与 chinese-days 双来源）；T4 系列固定年份注入** |
| `tests/holiday-module.test.ts` | 18 | 模块注册、4 个工具行为、job 与 onStart；**复审回归：is_workday/list 冷启动补抓的标题年选择、ready 短路、回退命中确认、chinese-days 回退与上一自然年补齐、混合源 list 报错** |
| `tests/config.test.ts` | +2 | `HOLIDAY_REFRESH_CRON` 默认值与 trim |
| `tests/fixtures/holiday-cn-2025.json` | — | 真实 holiday-cn 2025 数据（MIT） |
| `tests/fixtures/chinese-days-2025.json` | — | 真实 chinese-days 2025 数据（MIT） |
| `tests/fixtures/holiday-cn-2004.json` | — | 真实 2004 黄金周形态：22 holiday + 6 周末补班 |
| `tests/fixtures/holiday-cn-2019.json` | — | 真实 2019 形态：2018-12-29/30/31 跨年元旦 |

既有测试改动三处：`tests/config.test.ts`（+2 HOLIDAY_REFRESH_CRON 用例）、`tests/profile-schedule.test.ts` 与 `tests/schedule-migration.test.ts`（schema 版本断言 3→4）。

## 7. 测试与验证

```bash
npm run build
npm test            # 333 tests, 333 pass
```

实现期间已实际验证：
- 两个数据源 2025/2026 官方数据可抓取、可解析、可过校验；
- 手工对比 holiday-cn 与 chinese-days 2025 数据（28 个休假日、5 个调休上班日）一致。

未自动化验证（建议复审后做端到端）：
- 真实网络抓取未进 CI（fixture 驱动）；建议部署后在 scheduler 日志确认 `holiday.refresh_calendar` 抓取成功；
- 创建临时 workday 日程 → 触发 → Hermes 投递的完整链路。

## 8. 已知限制、权衡与风险点（复审重点）

1. **校验是启发式而非权威证明**：结构校验拦截明显错位/缺失/重复，但无法 100% 证明数据权威性；次年官方门槛（`papers`）是最重要的防线。
2. **`holidayNameHits` 使用子串匹配**：如「国庆」会命中「国庆节、中秋节」，用于节日窗口校验与补班日关联，语义上按设计如此，但需确认无漏判。
3. **`holiday` 频率含假期内普通周末**：这是确认过的语义（法定节假日休假日），与「只提醒调休放假的工作日」不同。
4. **时区限制**：workday/holiday 强制 `Asia/Shanghai`，不支持海外时区用户按中国历法在本地时间提醒（设计决定，可后续放开）。
5. **`holiday.next` 只读**：不触发懒补齐，覆盖不足返回 `unknown`；`list/is_workday/refresh` 才会懒补齐（未来年份走官方主源）。
6. **scheduler 每次启动的网络调用**：onStart 引导补齐有 6h 冷却；启动与每日 02:00 job 理论上可能并发抓取，SQLite 事务保证安全，至多多抓一次。
7. **`reconcileHolidaySchedules` 全表扫描 schedules**：当前数据规模无碍；超大部署可考虑按 `recurrence_json` 预筛或索引化。
8. **`count` 的回溯统计**：`countPriorHolidayAwareMatches` 从锚点日向前扫描到当前日，复杂度上界为「天数跨度」或「count 命中即停」；极端（2004 年锚点 + 超大 count）下每次 occurrence 计算可能有毫秒级成本。
9. **数据更新不产生通知**：节假日数据入库只记日志；「新安排已发布」的主动提醒是未做项，不在本期范围。
10. **多位置/企业日历**：不在本期范围；不支持港澳台假期。
11. **测试数据隔离**：新增测试沿用项目惯例——先设 `DATA_DIR` 再动态 `import`（ESM 静态 import 会先于 env 赋值执行，本任务中踩过此坑并已修正）。
12. **真实生产 DB**：开发期误写入的测试假日数据已清理，交付时 `data/` 中假日表为空。
13. **按日期范围替换的修订边界**：H1 后入库删除范围 = 本数据集 min/max date。同一年官方安排若发生「范围缩小/整体偏移」式修订，旧范围内、新范围外的个别行可能残留（相邻标题年之间互不重叠，跨年行不受影响）。实际发布形态几乎不会触发；如需强一致可在后续加标题年所有权标记。
14. **chinese-days 单自然年语义的视图/覆盖处理（N1/N3/N4）**：`isDateCoveredByHolidayData` 与 `ensureDayCoverage` 只把 `source === "holiday-cn"` 的 year+1 视为完整跨年覆盖；chinese-days 标题年视图只有 year-1 同为 chinese-days 时才完整——year-1 未 ready 返回 undefined（unknown），year-1 为 holiday-cn 时同样返回 undefined 且 `ensureYearForView` 不覆盖既有数据，`list` 经 viewOrFail 报错。chinese-days 的自然年文件含「本年 12 月下旬」行，它们属于 year+1 标题年，只在跨年/上一自然年场景按需读取；`dayInfo` 按日期直查不受影响。

## 9. 建议复审清单（Checklist）

> 与六轮复审缺陷对应的项目已修复并加回归测试：第一批 T1–T4、第二批 H1–H5、第三批 K1–K3、第四批 M1–M3、第五批 N1–N3、第六批 N4。以下清单供最终复核。

- [ ] `provider.ts`：兜底顺序、错误聚合、次年 `requireOfficialPapers` 门控是否在所有路径生效（含 allowFallback=true 时）；**复核 T1/T2/T3 校验规则与 H3 统一 20 天下限、H5 混合年行为**；
- [ ] `validateHolidayYear`：窗口表是否覆盖 2004–2100 全部历史发布形态；2024/2025/2026 真实数据过校验；**复核真实 2004 黄金周 fixture（22+6）与「仅放行上一年 12/20 后元旦」的边界**；
- [ ] `calendar.ts`：按日期范围替换的事务异常回滚与相邻标题年跨年行保留（H1）；`holidayYearView` 的 K1 范围 `[year-1-12-20, year-12-19]`、补班「最近段 + 10 天」关联；`nextHoliday` 跨年/ongoing/K3 非对称 ready 续扫边界；**M1/N1 `isDateCoveredByHolidayData` 区分 source、M3 `readHolidayYear` 标题年范围、N3/N4 chinese-days 视图缺口按 source 返回 unknown**；
- [ ] `holiday/index.ts`：K2 `ensureDayCoverage`（12 月下旬先 year+1 后 year）与 `ensureYearForView`（list 只确保标题年）的 ready 短路、失败路径与未来年官方门槛；**M2 自然年兜底必须命中权威行、N2 year+1 仅 holiday-cn 权威覆盖、N3 list 对 chinese-days 补齐 year-1、N4 补齐条件与视图缺口判断对称**；
- [ ] `service.ts`：inclusive/until/count 与 RRule 既有语义对齐；锚点早于/晚于 from 的行为；deadline 提醒与 workday/holiday 组合；**M1 日期级覆盖在 occurrence 扫描与 count 回溯两处一致；T4 在 create/update/reconcile 三处一致**；
- [ ] `reconcileHolidaySchedules`：乐观锁冲突、enabled/status 状态机、不推进 version 的并发后果；
- [ ] `scheduler.ts`：processDue 的三种终态（active 停用 / completed / 正常推进）；onStart 与 stop()/lease fence 交互；
- [ ] SQL：schema v4 迁移幂等、CHECK 约束、外键、旧库升级；
- [ ] 工具描述与 SKILL.md 是否足以让 Agent 正确表达「法定工作日/仅节假日」；
- [ ] 安全：无密钥硬编码、错误日志 URL 脱敏（`redactUrl`）、fixture 许可（MIT）；
- [ ] 测试隔离与确定性（不依赖真实当前日期跑关键断言；T4 系列已固定 `FIXED_TEST_YEAR=2026`，跨年运行需同步推进）。

## 10. 部署/运维注意

- 新增环境变量 `HOLIDAY_REFRESH_CRON`（可选，默认 `0 2 * * *`），已写入 `.env.example`；
- 无需修改 Hermes MCP 注册命令（工具自动多出 4 个，如需限制工具选择用 `hermes mcp configure`）；
- 升级后启动 scheduler 会立即尝试补齐当年节假日数据；网络受限环境会记录失败并每 6 小时重试；
- schema 升级为 v4 由启动时自动完成，无需手工迁移；建议升级前按项目惯例备份 SQLite。

---

*本文件由实现方整理，供第三方复审使用；与代码不一致之处以代码为准，发现偏差请反馈。*
