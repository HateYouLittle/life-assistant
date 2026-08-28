import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-bk-notify-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";
process.env.LIFE_ASSISTANT_TIMEZONE = "Asia/Shanghai";
// 不配置推送路由：通知走 notify.pull 落库路径，断言 profile_notifications 行即可。

const { requireProfileContext } = await import("../src/core/profile.js");
const { getDatabase } = await import("../src/core/database.js");
const svc = await import("../src/modules/bookkeeping/service.js");
// 模块渲染器注册（生产由 modules/index 全量加载；这里显式加载 notification 模块）
await import("../src/modules/bookkeeping/notification.js");
const { renderNotification } = await import("../src/core/notification.js");

const db = getDatabase();

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function noticesFor(profileId: string): Array<Record<string, unknown>> {
  return db.prepare(
    "SELECT id, source, title, body, dedupe_key, envelope FROM profile_notifications WHERE profile_id = ? ORDER BY id",
  ).all(profileId) as Array<Record<string, unknown>>;
}

test("shared entry add notifies every member except the actor", async () => {
  const a = requireProfileContext("profile-a");
  const b = requireProfileContext("profile-b");
  const ledger = svc.createSharedLedger(a, "通知家庭账本");
  svc.addLedgerMember(a, ledger.id, "profile-b");
  const pool = svc.createAccount(a, { name: "通知资金池", ledgerId: ledger.id });

  const at = new Date("2026-08-10T08:00:00.000Z");
  const entry = await svc.addEntry(a, { type: "expense", amount: 35, category: "餐饮", accountId: pool.id }, at);

  const aNotices = noticesFor("profile-a").filter((n) => n.source === "bookkeeping");
  const bNotices = noticesFor("profile-b").filter((n) => n.source === "bookkeeping");
  // 记录人自己不收通知；其他成员各收一条
  assert.equal(aNotices.length, 0);
  assert.equal(bNotices.length, 1);

  const expectedKey = `bookkeeping:${ledger.id}:${entry.id}:add:${entry.updatedAt}`;
  assert.equal(bNotices[0].dedupe_key, expectedKey);
  assert.equal(bNotices[0].title, "通知家庭账本 · profile-a 记了一笔支出 ¥35.00（餐饮）");
  assert.match(String(bNotices[0].body), /记录人：profile-a/);
  assert.match(String(bNotices[0].body), /金额：¥35\.00/);

  // 个人账本写入不产生任何通知
  await svc.addEntry(b, { type: "expense", amount: 3, category: "个人消费" });
  assert.equal(noticesFor("profile-a").filter((n) => n.source === "bookkeeping").length, 0);
});

test("two updates of the same entry produce two deliverable notices via updatedAt identity", async () => {
  const a = requireProfileContext("profile-a");
  const ledger = svc.listLedgers(a).find((v) => v.name === "通知家庭账本")!;
  const pool = svc.listAccounts(a, ledger.id)[0];
  const entry = await svc.addEntry(a, { type: "expense", amount: 10, category: "交通", accountId: pool.id }, new Date("2026-08-10T09:00:00.000Z"));

  const first = await svc.updateEntry(a, ledger.id, entry.id, { version: entry.version, amount: 12 }, new Date("2026-08-10T09:05:00.000Z"));
  const second = await svc.updateEntry(a, ledger.id, entry.id, { version: first.version, amount: 14 }, new Date("2026-08-10T09:10:00.000Z"));

  const keys = noticesFor("profile-b")
    .map((n) => n.dedupe_key)
    .filter((key) => String(key).includes(`${entry.id}:update:`));
  assert.deepEqual(keys, [
    `bookkeeping:${ledger.id}:${entry.id}:update:${first.updatedAt}`,
    `bookkeeping:${ledger.id}:${entry.id}:update:${second.updatedAt}`,
  ]);

  // 渲染器注册生效：修改与删除通知能按 RenderBlock 投影
  await svc.deleteEntry(a, ledger.id, entry.id, second.version);
  const deleteNotices = noticesFor("profile-b").filter((n) => String(n.dedupe_key).includes(`${entry.id}:delete:`));
  assert.equal(deleteNotices.length, 1);
  assert.equal(deleteNotices[0].title, "通知家庭账本 · profile-a 删除了一笔支出 ¥14.00（交通）");
});

test("monthly report aggregates last month and is idempotent per profile+month", async () => {
  const a = requireProfileContext("profile-a");
  const b = requireProfileContext("profile-b");
  const c = requireProfileContext("profile-c");

  // a：上月个人收支；与 b 共享一个有动态的账本；c 只有安静账本（上月无任何流水）
  const shared = svc.createSharedLedger(a, "月报共享账本");
  svc.addLedgerMember(a, shared.id, "profile-b");
  const pool = svc.createAccount(a, { name: "月报资金池", initialBalance: 400, ledgerId: shared.id });
  svc.createSharedLedger(c, "安静账本");

  const aPersonal = svc.ensurePersonalLedger(a).id;
  await svc.addEntry(a, { type: "expense", amount: 120, category: "餐饮", occurredAt: "2026-07-02T02:00:00.000Z" });
  await svc.addEntry(a, { type: "expense", amount: 80, category: "交通", occurredAt: "2026-07-03T02:00:00.000Z" });
  await svc.addEntry(a, { type: "expense", amount: 40, category: "餐饮", occurredAt: "2026-07-04T02:00:00.000Z" });
  await svc.addEntry(a, { type: "income", amount: 900, category: "工资", occurredAt: "2026-07-05T02:00:00.000Z" });
  // 本月流水，不应计入上月报表
  await svc.addEntry(a, { type: "expense", amount: 999, category: "餐饮", occurredAt: "2026-08-02T02:00:00.000Z" });
  await svc.addEntry(b, { type: "expense", amount: 60, category: "家用", accountId: pool.id, occurredAt: "2026-07-06T02:00:00.000Z" });

  const at = new Date("2026-08-01T01:00:00.000Z"); // 上海 8 月 1 日 → 上月 = 2026-07
  const published = await svc.runMonthlyReports({ at });
  assert.deepEqual(published.sort(), ["profile-a", "profile-b", "profile-c"].filter((p) => p !== "profile-c").sort());

  const aRows = noticesFor("profile-a").filter((n) => String(n.dedupe_key).startsWith("bookkeeping:profile-a:2026-07"));
  assert.equal(aRows.length, 1);
  assert.match(String(aRows[0].title), /2026-07 月度账单 · 收入 ¥900\.00 · 支出 ¥240\.00/);

  // envelope 落库：结构化 payload 可校验
  const envelope = JSON.parse(String(aRows[0].envelope));
  assert.equal(envelope.kind, "bookkeeping.monthly_report");
  assert.equal(envelope.payload.personal.incomeCents, 90000);
  assert.equal(envelope.payload.personal.expenseCents, 24000);
  assert.deepEqual(envelope.payload.personal.topCategories, [
    { category: "餐饮", amountCents: 16000 },
    { category: "交通", amountCents: 8000 },
  ]);
  const sharedPart = envelope.payload.shared.find((part: { ledgerId: string }) => part.ledgerId === shared.id);
  assert.equal(sharedPart.expenseCents, 6000);
  assert.equal(sharedPart.balanceCents, 40000 - 6000);

  // b 与 c：b 有共享动态 → 有报表；c 无上月数据 → 静默跳过
  assert.equal(noticesFor("profile-b").filter((n) => String(n.dedupe_key) === "bookkeeping:profile-b:2026-07").length, 1);
  assert.equal(noticesFor("profile-c").filter((n) => n.source === "bookkeeping").length, 0);

  // identity = profileId:month，job 重跑不重复推
  await svc.runMonthlyReports({ at });
  assert.equal(noticesFor("profile-a").filter((n) => String(n.dedupe_key).startsWith("bookkeeping:profile-a:2026-07")).length, 1);
  assert.equal(noticesFor("profile-b").filter((n) => String(n.dedupe_key) === "bookkeeping:profile-b:2026-07").length, 1);
});

test("shared entry notification renders through the registered block renderer", async () => {
  const a = requireProfileContext("profile-a");
  const ledger = svc.listLedgers(a).find((v) => v.name === "通知家庭账本")!;
  const pool = svc.listAccounts(a, ledger.id)[0];
  const at = new Date("2026-08-11T08:30:00.000Z");
  const entry = await svc.addEntry(a, { type: "expense", amount: 12.5, category: "日用", note: "纸巾", accountId: pool.id }, at);

  const row = noticesFor("profile-b").find((n) => String(n.dedupe_key) === `bookkeeping:${ledger.id}:${entry.id}:add:${entry.updatedAt}`)!;
  assert.ok(row, "成员通知应已落库");
  assert.equal(row.title, "通知家庭账本 · profile-a 记了一笔支出 ¥12.50（日用）");
  assert.equal(row.body, [
    "账本：通知家庭账本",
    "类型：支出",
    "金额：¥12.50",
    "分类：日用",
    "记录人：profile-a",
    "时间：2026-08-11 16:30",
    "备注：纸巾",
  ].join("\n"));
});

test("cross-ledger shared transfer notifies members of both ledgers", async () => {
  const a = requireProfileContext("profile-a");
  const ledgerA = svc.createSharedLedger(a, "双账本A");
  svc.addLedgerMember(a, ledgerA.id, "profile-b");
  const ledgerB = svc.createSharedLedger(a, "双账本B");
  svc.addLedgerMember(a, ledgerB.id, "profile-c");
  const poolA = svc.createAccount(a, { name: "A池", ledgerId: ledgerA.id });
  const poolB = svc.createAccount(a, { name: "B池", ledgerId: ledgerB.id });

  // 流水归属源账本 A，但转账两端账本的成员（b、c）都要收到通知
  const t = await svc.addEntry(a, { type: "transfer", amount: 10, accountId: poolA.id, toAccountId: poolB.id });
  assert.equal(t.ledgerId, ledgerA.id);
  const keysOf = (profileId: string): string[] => noticesFor(profileId).map((n) => String(n.dedupe_key));
  assert.ok(keysOf("profile-b").includes(`bookkeeping:${ledgerA.id}:${t.id}:add:${t.updatedAt}`));
  assert.ok(keysOf("profile-c").includes(`bookkeeping:${ledgerB.id}:${t.id}:add:${t.updatedAt}`));

  // 删除该转账：两端账本成员同样各收一条 delete 通知
  await svc.deleteEntry(a, ledgerA.id, t.id, t.version);
  assert.ok(keysOf("profile-b").some((k) => k.startsWith(`bookkeeping:${ledgerA.id}:${t.id}:delete:`)));
  assert.ok(keysOf("profile-c").some((k) => k.startsWith(`bookkeeping:${ledgerB.id}:${t.id}:delete:`)));
});

test("moving an entry to another ledger notifies the source ledger members too", async () => {
  const a = requireProfileContext("profile-a");
  const b = requireProfileContext("profile-b");
  const ledgerA = svc.listLedgers(a).find((v) => v.name === "双账本A")!;
  const ledgerB = svc.listLedgers(a).find((v) => v.name === "双账本B")!;
  const poolA = svc.listAccounts(a, ledgerA.id).find((x) => x.name === "A池")!;
  const poolB = svc.listAccounts(a, ledgerB.id).find((x) => x.name === "B池")!;

  // b 在账本 A 记账，a（owner，两个账本都有权限）把它改挂到账本 B 的共享账户
  const entry = await svc.addEntry(b, { type: "expense", amount: 5, category: "搬家", accountId: poolA.id });
  assert.equal(entry.ledgerId, ledgerA.id);
  const moved = await svc.updateEntry(a, ledgerA.id, entry.id, { version: entry.version, accountId: poolB.id });
  assert.equal(moved.ledgerId, ledgerB.id);

  const keysOf = (profileId: string): string[] => noticesFor(profileId).map((n) => String(n.dedupe_key));
  // 原账本成员 b（否则流水「凭空消失」）与目标账本成员 c 都收到 update 通知
  assert.ok(keysOf("profile-b").some((k) => k.startsWith(`bookkeeping:${ledgerA.id}:${entry.id}:update:`)));
  assert.ok(keysOf("profile-c").some((k) => k.startsWith(`bookkeeping:${ledgerB.id}:${entry.id}:update:`)));
});
