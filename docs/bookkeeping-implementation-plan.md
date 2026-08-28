# 记账模块(bookkeeping)实施方案

> 状态:已评审定稿,待实现。新会话可直接按本文档开工,无需其他上下文。
> 需求结论:完整版(含账户/转账);共享账本需支持**成员共享的共同账户**(余额全员共享可见);通知做"成员动态 + 月度账单"。

## 1. 目标

- **个人账本**:每个 Profile 私有,含账户、收支、转账、统计。
- **共享账本**:多成员账本,支持共享共同账户(如家庭公共资金池);成员记账互相通知;每月 1 号推送上月收支汇总。

## 2. 现有架构要点(实现必读,已核对源码)

| 事实 | 位置 |
|---|---|
| 模块接口 `AssistantModule { name, tools?, jobs?, tick?, onStart? }`,自注册 `registerModule` | `src/core/registry.ts:59-80` |
| 工具定义 `ToolDef { name, description, schema: ZodRawShape, handler(args, context?) }`,完整名 = `${module.name}.${tool.name}` | `src/core/registry.ts:10-17` |
| 统一构造器 `withTool(def, schema, run)`:schema 只声明一次,异常自动转 `fail()`;结果助手 `ok()/fail()` | `src/core/registry.ts:35-53, 86-94` |
| 模块清单:新增模块 = 新目录 + 在此 import 一行,核心零改动 | `src/modules/index.ts` |
| Profile 即身份:`ProfileContext = { id }`;`requireProfileContext()` 读 env `HERMES_PROFILE`,无静默回退;`asProfileContext()` 归一化服务层入参;`isWellFormedId()` 校验 | `src/core/profile.ts`(全文 27 行) |
| 进程边界:每个 MCP stdio 进程绑定一个 Profile;工具**永不**接受调用方传 profileId;scheduler 进程无 Profile、遍历所有 Profile 的数据 | `src/index.ts:10`、`docs/architecture.md` §1 |
| 持久化:单 SQLite 文件 `config.dataDir/life-assistant.sqlite`(node:sqlite `DatabaseSync`,WAL);集中幂等迁移 `migrateDatabaseSchema(db)`(BEGIN IMMEDIATE 内全部 `CREATE TABLE IF NOT EXISTS` + `ensureColumn` 增列) | `src/core/database.ts:20-213` |
| 版本护栏/戳:护栏在迁移函数内(`existingVersion > 7` 抛错,`:182`),版本戳 `INSERT OR REPLACE ... 'version','7'`(`:207`)。**加表需新增 CREATE 语句并把两处 7 → 8** | `src/core/database.ts:177-207` |
| Profile 私有表惯例:PK `(profile_id, id)`,全部查询 `WHERE profile_id = ?`(参照 `automations` 表 `database.ts:156-171`) | — |
| ID 生成:`crypto.randomUUID()`;导入场景校验 `isWellFormedId`(参照 `createSchedule`) | `src/modules/schedule/service.ts:902-906` |
| 通知信封:模块自定义 payload,`EnvelopeFor<K, P>` 收紧类型;`registerNotificationBlocks(kind, fn)` 注册 RenderBlock[] 渲染器(重复注册抛错,模块 notification.ts 顶部 import 副作用完成) | `src/core/notification.ts:40-43, 70-89` |
| 发布:`publishNotification(envelope)`(无需注入 publishers,默认走真实管道);dedupeKey = `${source}:${identity}`;profile scope → `publishProfile`(未配推送路由的成员走 `notify.pull` 拉取) | `src/core/notification-publisher.ts:34-72` |
| 定时任务:`JobDef { name, cron, timezone?, handler(ctx) }`;cron 默认值集中在 `config.cron`,env 可覆盖;时区用 `config.timezone` | `src/core/registry.ts:24-29`、`src/config.ts:105-113` |
| 公共任务物化原则:无 Profile 的 job 必须遍历有数据的 Profile 逐个 `publishProfile` | `docs/architecture.md` §9 |
| 测试:node:test + assert/strict;先设 `process.env.DATA_DIR`(mkdtempSync 临时目录)/`HERMES_PROFILE` 再动态 import(需不同 env 时用 cache-busting 查询串);`resetDatabaseForTests()` 可用 | `tests/profile-schedule.test.ts:14-88`、`src/core/database.ts:312-315` |
| 工程约定:TDD;工具 description 是 LLM 契约必须写清;提交格式 `type(scope): message` | `CONTRIBUTING.md` |

## 3. 数据模型(schema v7 → v8)

4 张新表加入 `migrateDatabaseSchema` 的 CREATE 区(参照 `automations` 位置),并补索引;`database.ts:182` 护栏与 `:207` 版本戳同步改 8。

```sql
CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- 'personal' | 'shared'
  name TEXT NOT NULL,
  owner_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_members (
  ledger_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'member'
  joined_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, profile_id)
);
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- 'personal' | 'shared'
  owner_profile_id TEXT,                -- kind=personal 必填;shared 为 NULL
  ledger_id TEXT,                       -- kind=shared 必填;personal 为 NULL
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',   -- 'cash'|'bank'|'alipay'|'wechat'|'other'
  archived INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  ledger_id TEXT NOT NULL,
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,             -- 记录人
  type TEXT NOT NULL,                   -- 'expense' | 'income' | 'transfer'
  amount_cents INTEGER NOT NULL,        -- 正整数(分)
  category TEXT,                        -- transfer 为 NULL
  account_id TEXT,                      -- expense/income 的账户;transfer 的源账户
  to_account_id TEXT,                   -- 仅 transfer
  occurred_at TEXT NOT NULL,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,   -- 乐观锁
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_time ON ledger_entries(ledger_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner ON ledger_accounts(owner_profile_id);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_ledger ON ledger_accounts(ledger_id);
```

**关键设计决策:**

- **个人账本 = 单成员账本**:首次使用记账工具时懒创建(`type='personal'`,owner=当前 Profile,owner 也写入 `ledger_members`)。个人/共享共用同一套权限与流水代码,权限判定统一为"当前 Profile 在 `ledger_members` 中是否有对应角色"。
- **余额不落库,由流水派生**(多成员并发下不漂移)。单条 SQL 跨账本聚合任一账户余额:

```sql
SELECT COALESCE(SUM(CASE
  WHEN type = 'income'   AND account_id = :id  THEN amount_cents
  WHEN type = 'expense'  AND account_id = :id  THEN -amount_cents
  WHEN type = 'transfer' AND account_id = :id  THEN -amount_cents
  WHEN type = 'transfer' AND to_account_id = :id THEN amount_cents
  ELSE 0 END), 0) AS balance_cents
FROM ledger_entries WHERE account_id = :id OR to_account_id = :id
```

- **金额口径**:工具入参用元(number,> 0,最多两位小数,`Math.round(amount * 100)` 转分存储;校验 `Number.isFinite` 且 `|amount*100 - round(amount*100)| < 1e-6`)。
- **初始余额**:`account_create` 传 `initialBalance` 时自动插一条 `type='income'`、category `期初余额` 的流水。
- **流水归属规则**(决定 entry 落哪个 ledger):
  - expense/income:归属**账户所在账本**(个人账户 → 该 Profile 个人账本;共享账户 → 共享账本;无账户 → 记录人个人账本)。
  - transfer:恰一端为共享账户 → 记入该共享账本(全员可见);两端皆共享 → 源账户账本;两端皆个人 → 记录人个人账本。
- **时间**:所有时间戳 ISO 字符串(`occurred_at` 默认当前时间,接受调用方传入);报表聚合用 luxon + `config.timezone` 按自然月切。

## 4. 授权模型(全部在 service 层校验,工具层不可信)

| 操作 | 规则 |
|---|---|
| 读账本/流水/账户与余额 | 个人账本仅 owner;共享账本仅成员 |
| 记账(entry_add) | 个人账本 owner;共享账本任意成员 |
| 改/删流水 | 记录人本人,或共享账本 owner(可改删任何人的) |
| member_add / member_remove | 共享账本 owner;不能移除 owner 本人;`profileId` 仅要求 `isWellFormedId` |
| 建共享账户 / 改/删共享账户 | 共享账本 owner |
| 建/改/删个人账户 | 本人 |
| 用共享账户记账 | 该账本任意成员 |

当前身份一律来自 `requireProfileContext()`(或 handler 传入的 `context`),仿 schedule 的 `context ?? requireProfileContext()` 写法。

## 5. MCP 工具(14 个,`withTool` 模式,zod schema 一次声明)

description 用中文写清 LLM 契约(适用场景、参数含义、金额单位是元),风格对齐 `src/modules/schedule/index.ts`。

| 工具 | 参数(摘要) | 行为 |
|---|---|---|
| `ledger_list` | — | 个人账本 + 已加入共享账本(成员数、账户余额概要) |
| `ledger_create` | `name` | 建共享账本,创建者即 owner,并自动加入 members |
| `member_add` | `ledgerId`, `profileId` | owner 专属;加成员 |
| `member_remove` | `ledgerId`, `profileId` | owner 专属;不能移除 owner |
| `account_create` | `name`, `type`(enum), `ledgerId?`(建共享账户,owner), `initialBalance?`(元) | 建账户;带初始余额则补期初流水 |
| `account_list` | `ledgerId?` | 本人个人账户 + 所在共享账本账户,含实时余额 |
| `account_update` | `accountId`, `name?`, `type?`, `archived?` | 改名/归档 |
| `account_delete` | `accountId` | 仍被流水引用时拒绝并提示改用归档 |
| `entry_add` | `type`(expense/income/transfer), `amount`(元>0), `category?`(expense/income 必填,transfer 禁止), `accountId?`, `toAccountId?`(transfer 必填且 ≠ accountId), `occurredAt?`, `note?` | 记一笔;按 §3 归属规则落账本;落共享账本时触发成员通知(§6) |
| `entry_list` | `ledgerId?`(默认个人), `type?`, `category?`, `from?`, `to?`, `limit?`, `offset?` | 按 `occurred_at` 倒序分页 |
| `entry_get` | `ledgerId`, `entryId` | 单条详情 |
| `entry_update` | `ledgerId`, `entryId`, `version`(乐观锁), `amount?`, `category?`, `accountId?`, `toAccountId?`, `occurredAt?`, `note?` | `WHERE ... AND version = ?`,冲突报错提示重试;共享账本触发通知 |
| `entry_delete` | `ledgerId`, `entryId`, `version` | 同上乐观锁;共享账本触发通知 |
| `summary` | `ledgerId?`(默认个人), `month?`(`yyyy-LL`,默认当月) | 收/支/结余、分类聚合(分→元输出)、账户余额清单 |

## 6. 通知(模块内 `notification.ts`,2 个 kind)

参照 `src/modules/schedule/notification.ts` 的结构:payload 类型 + `EnvelopeFor` + builder + `registerNotificationBlocks`(RenderBlock 用 `line`/`label` 块,中文文案)。

1. **`bookkeeping.shared_entry`**(共享账本成员动态)
   - 触发:entry_add / entry_update / entry_delete 涉及共享账本时,service 对**除记录人外**的每个成员各发一条 profile scope 信封(`source: "bookkeeping"`)。通知账本集合按流水账户端点推导:转账两端分属不同共享账本时两端成员都通知;entry_update 把流水改挂到其他账本时,原账本成员也通知(否则流水「凭空消失」无人知晓)。
   - `identity` 必须含变化标记,防止 dedupeKey(`source:identity`)吞掉后续修改:`${ledgerId}:${entryId}:${action}:${entry.updatedAt}`,action ∈ add/update/delete。
   - payload:`{ ledgerId, ledgerName, entryId, action, entryType, amountCents, category?, note?, actorProfileId, occurredAt, generatedAt }`。
   - headline 例:`家庭账本 · 小王记了一笔支出 ¥35.00(餐饮)`。
2. **`bookkeeping.monthly_report`**(月度账单)
   - payload:`{ profileId, month, personal: { incomeCents, expenseCents, netCents, topCategories[] }, shared: [{ ledgerId, ledgerName, incomeCents, expenseCents, balanceCents }], generatedAt }`。
   - `identity`: `${profileId}:${month}`(天然幂等,job 重跑不重复推)。

发布统一走 `await publishNotification(envelope)`(默认 publishers),通知失败不回滚记账(对齐 schedule/tick 的容错风格:记录日志继续)。

## 7. 定时任务与配置

- 模块 `jobs`: `{ name: "monthly_report", cron: config.cron.bookkeepingReport, timezone: config.timezone, handler: runMonthlyReports }`。
- handler(无 Profile 运行):`SELECT DISTINCT profile_id FROM ledger_members` → 逐 Profile 统计**上一个自然月**(config.timezone)个人 + 各共享账本数据 → 逐 Profile 构建信封发布(架构"公共任务按 Profile 物化"原则);无数据的 Profile 自然被成员查询过滤掉。
- `src/config.ts` 的 `cron` 对象新增一行(对齐现有风格):

```ts
bookkeepingReport: nonBlankOrDefault(process.env.BOOKKEEPING_REPORT_CRON, "0 9 1 * *"),
```

- `.env.example` 可补注释示例(升级不强制改配置)。

## 8. 文件改动清单

**新增 `src/modules/bookkeeping/`:**

- `types.ts` — 实体类型、输入类型、共享 zod schema 片段(金额、分类型 enum)。
- `service.ts` — 全部业务/SQL/授权:ensurePersonalLedger、ledger/member/account/entry CRUD、余额派生、summary 聚合、月度报表数据组装。防御式 hydration + 乐观锁对齐 `schedule/service.ts`。
- `notification.ts` — 两个 kind 的 builder + 渲染器注册。
- `index.ts` — 14 个工具 + jobs + `registerModule`;**import `"./notification.js"` 触发渲染器副作用注册**(对齐 schedule/index.ts:4)。

**修改:**

- `src/core/database.ts` — 4 表 + 索引进迁移;护栏 `:182` 与版本戳 `:207` 7→8。
- `tests/database-version.test.ts` — 断言中的受支持版本号同步(先读该测试确认写死位置)。
- `src/config.ts` — `cron.bookkeepingReport`。
- `src/modules/index.ts` — `import "./bookkeeping/index.js";` 一行。
- `README.md` — 工具清单(现有 32 个,§"可用工具"列表)与简介补 bookkeeping。
- `docs/architecture.md` — §2 数据归属表补 4 张表(共享账本=首个跨 Profile 可写资源,注明授权模型)。

**明确不做(v1 范围外):** assistant 模块导出/导入接入、多币种、预算管理、成员角色细分(仅 owner/member 两级)、共享账本删除。

## 9. 测试计划(TDD,先红后绿)

沿用 `tests/profile-schedule.test.ts` 模式:临时 `DATA_DIR`、先设 env 后动态 import、注入时钟/假发布。

1. `tests/bookkeeping-service.test.ts` — 个人账本懒创建;账户 CRUD 与删除守卫;余额派生(含转账双边、跨账本转账后期余额正确);entry CRUD + 乐观锁冲突;金额边界(两位小数通过、三位小数/0/负数拒绝);summary 聚合正确(含跨月切分)。
2. `tests/bookkeeping-shared.test.ts` — 共享账本生命周期;非成员不可见/不可写;member 可记账、只能改删自己的流水;owner 可改删任何流水、管理成员、建共享账户;member_remove 守卫(不能移除 owner);A/B 两 Profile 隔离断言(仿 profile-schedule 的双 Profile 用法)。
3. `tests/bookkeeping-notification.test.ts` — 共享记账通知其他成员且**不**通知记录人;identity 含 updatedAt(同一流水两次修改两条通知均可投递);monthly_report:上月数据汇总正确、仅发给有记账数据的 Profile、identity 幂等。
4. 回归:`npm test` 全量 + `npm run build` 通过。

## 10. 建议实施顺序

1. database.ts v8 迁移 + database-version.test.ts 同步(绿)。
2. types.ts + service.ts 个人账本部分(账户/流水/summary)→ bookkeeping-service.test.ts(红→绿)。
3. service.ts 共享部分(成员/授权/跨账本转账)→ bookkeeping-shared.test.ts(红→绿)。
4. notification.ts + service 写路径挂通知 → bookkeeping-notification.test.ts(红→绿)。
5. index.ts 工具层 + config.ts cron + monthly_report job。
6. modules/index.ts 注册、README/architecture 文档同步。
7. 全量 `npm test` + `npm run build`;提交按 `feat(bookkeeping): ...` 拆分(迁移/服务/通知/工具可分 commit)。
