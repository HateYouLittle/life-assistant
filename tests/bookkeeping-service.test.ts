import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-bookkeeping-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";
// 汇总按自然月切分依赖时区，测试固定为 Asia/Shanghai 保证确定性。
process.env.LIFE_ASSISTANT_TIMEZONE = "Asia/Shanghai";

const { requireProfileContext } = await import("../src/core/profile.js");
const { getDatabase } = await import("../src/core/database.js");
const svc = await import("../src/modules/bookkeeping/service.js");
const { amountYuanSchema, MAX_AMOUNT_YUAN } = await import("../src/modules/bookkeeping/types.js");

const db = getDatabase();

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("personal ledger is lazily created exactly once", () => {
  const a = requireProfileContext("profile-a");
  const first = svc.ensurePersonalLedger(a);
  assert.equal(first.type, "personal");
  assert.equal(first.ownerProfileId, "profile-a");

  const views = svc.listLedgers(a);
  assert.equal(views.length, 1);
  assert.equal(views[0].id, first.id);
  assert.equal(views[0].type, "personal");
  assert.equal(views[0].role, "owner");
  assert.equal(views[0].memberCount, 1);

  const again = svc.ensurePersonalLedger(a);
  assert.equal(again.id, first.id);
  assert.equal(svc.listLedgers(a).length, 1);
});

test("personal ledger is invisible to another profile", () => {
  const a = requireProfileContext("profile-a");
  const ledgerId = svc.ensurePersonalLedger(a).id;
  const b = requireProfileContext("profile-b");
  assert.throws(() => svc.listEntries(b, ledgerId), /ledger not found/i);
  assert.throws(() => svc.summarizeLedger(b, ledgerId), /ledger not found/i);
  assert.equal(svc.listLedgers(b).every((view) => view.id !== ledgerId), true);
});

test("account CRUD with initial balance and derived balance", async () => {
  const a = requireProfileContext("profile-a");
  const account = await svc.createAccount(a, { name: "现金钱包", type: "cash", initialBalance: 100.5 });
  assert.equal(account.kind, "personal");
  assert.equal(account.ownerProfileId, "profile-a");
  assert.equal(account.balanceCents, 10050);

  // 初始余额生成一条「期初余额」收入流水
  const opening = svc.listEntries(a, undefined, { category: "期初余额" });
  assert.equal(opening.length, 1);
  assert.equal(opening[0].type, "income");
  assert.equal(opening[0].amountCents, 10050);
  assert.equal(opening[0].accountId, account.id);

  const updated = svc.updateAccount(a, account.id, { name: "随身现金", type: "bank", archived: true });
  assert.equal(updated.name, "随身现金");
  assert.equal(updated.type, "bank");
  assert.equal(updated.archived, true);
  assert.equal(updated.version, 2);
  assert.equal(updated.balanceCents, 10050);

  const unused = await svc.createAccount(a, { name: "临时账户" });
  svc.deleteAccount(a, unused.id);
  assert.throws(() => svc.updateAccount(a, unused.id, { name: "gone" }), /account not found/i);

  assert.throws(() => svc.deleteAccount(a, account.id), /archive it instead/i);
});

test("entries adjust derived balances including double-sided transfers", async () => {
  const a = requireProfileContext("profile-a");
  const wallet = await svc.createAccount(a, { name: "余额测试-钱包", type: "cash" });
  const bank = await svc.createAccount(a, { name: "余额测试-银行卡", type: "bank", initialBalance: 200 });

  await svc.addEntry(a, { type: "expense", amount: 35.5, category: "餐饮", accountId: wallet.id });
  assert.equal(svc.listAccounts(a).find((x) => x.id === wallet.id)!.balanceCents, -3550);

  await svc.addEntry(a, { type: "income", amount: 100, category: "工资", accountId: wallet.id });
  await svc.addEntry(a, { type: "transfer", amount: 20, accountId: bank.id, toAccountId: wallet.id });

  const accounts = svc.listAccounts(a);
  assert.equal(accounts.find((x) => x.id === wallet.id)!.balanceCents, 8450); // -35.5 + 100 + 20 = 84.5
  assert.equal(accounts.find((x) => x.id === bank.id)!.balanceCents, 18000); // 200 - 20

  // 无账户的收支仍可记账，落个人账本
  const orphan = await svc.addEntry(a, { type: "expense", amount: 9.9, category: "杂项" });
  assert.equal(orphan.accountId, undefined);
});

test("entry update and delete enforce optimistic locking", async () => {
  const a = requireProfileContext("profile-a");
  const entry = await svc.addEntry(a, { type: "expense", amount: 10, category: "交通", note: "地铁" });

  await assert.rejects(
    () => svc.updateEntry(a, entry.ledgerId, entry.id, { version: 99, amount: 12 }),
    /current version is 1.*expected version 99/i,
  );
  const updated = await svc.updateEntry(a, entry.ledgerId, entry.id, { version: entry.version, amount: 12, note: "地铁通勤" });
  assert.equal(updated.amountCents, 1200);
  assert.equal(updated.note, "地铁通勤");
  assert.equal(updated.version, 2);

  await assert.rejects(
    () => svc.deleteEntry(a, entry.ledgerId, entry.id, 1),
    /current version is 2.*expected version 1/i,
  );
  const deleted = await svc.deleteEntry(a, entry.ledgerId, entry.id, updated.version);
  assert.equal(deleted.id, entry.id);
  assert.throws(() => svc.getEntry(a, entry.ledgerId, entry.id), /entry not found/i);
});

test("amount validation rejects zero, negative, non-finite and 3+ decimals", async () => {
  const a = requireProfileContext("profile-a");
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 35.123, 0.001]) {
    await assert.rejects(
      () => svc.addEntry(a, { type: "expense", amount: bad, category: "测试" }),
      /amount/,
      `expected rejection for amount ${bad}`,
    );
  }
  const ok1 = await svc.addEntry(a, { type: "expense", amount: 0.01, category: "测试" });
  assert.equal(ok1.amountCents, 1);
  const ok2 = await svc.addEntry(a, { type: "expense", amount: 19.99, category: "测试" });
  assert.equal(ok2.amountCents, 1999);
});

test("category rules: required for expense/income, forbidden for transfer", async () => {
  const a = requireProfileContext("profile-a");
  const wallet = await svc.createAccount(a, { name: "分类规则-钱包" });
  await assert.rejects(() => svc.addEntry(a, { type: "expense", amount: 1 }), /category is required/i);
  await assert.rejects(() => svc.addEntry(a, { type: "income", amount: 1 }), /category is required/i);
  await assert.rejects(
    () => svc.addEntry(a, { type: "transfer", amount: 1, category: "搬家", accountId: wallet.id, toAccountId: wallet.id }),
    /must not have a category|two different accounts/,
  );
  // transfer 需要两个不同账户
  const other = await svc.createAccount(a, { name: "分类规则-银行卡" });
  await assert.rejects(
    () => svc.addEntry(a, { type: "transfer", amount: 1, accountId: wallet.id, toAccountId: wallet.id }),
    /two different accounts/,
  );
  const moved = await svc.addEntry(a, { type: "transfer", amount: 1, accountId: wallet.id, toAccountId: other.id });
  assert.equal(moved.category, undefined);
  assert.equal(moved.toAccountId, other.id);
});

test("entry list filters and paginates by occurred_at desc", async () => {
  const a = requireProfileContext("profile-a");
  await svc.addEntry(a, { type: "expense", amount: 1, category: "分页", occurredAt: "2026-08-01T00:00:00.000Z" });
  await svc.addEntry(a, { type: "expense", amount: 2, category: "分页", occurredAt: "2026-08-02T00:00:00.000Z" });
  await svc.addEntry(a, { type: "income", amount: 3, category: "分页", occurredAt: "2026-08-03T00:00:00.000Z" });

  const all = svc.listEntries(a, undefined, { category: "分页" });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.amountCents), [300, 200, 100]); // occurred_at 倒序

  const onlyExpense = svc.listEntries(a, undefined, { category: "分页", type: "expense" });
  assert.equal(onlyExpense.length, 2);
  const paged = svc.listEntries(a, undefined, { category: "分页", limit: 1, offset: 1 });
  assert.equal(paged.length, 1);
  assert.equal(paged[0].amountCents, 200);
  const ranged = svc.listEntries(a, undefined, { category: "分页", from: "2026-08-02T00:00:00.000Z" });
  assert.deepEqual(ranged.map((e) => e.amountCents), [300, 200]);
});

test("summary aggregates income/expense/categories by calendar month in local timezone", async () => {
  // 独立 Profile，避免与前面用例的个人账本数据串扰
  const s = requireProfileContext("profile-summary");
  const ledgerId = svc.ensurePersonalLedger(s).id;
  const wallet = await svc.createAccount(s, { name: "汇总-钱包" });
  // 上海 = UTC+8：07-31T15:00Z 仍是 7 月 31 日；07-31T17:00Z 已是 8 月 1 日
  await svc.addEntry(s, { type: "expense", amount: 100, category: "餐饮", accountId: wallet.id, occurredAt: "2026-07-30T10:00:00.000Z" });
  await svc.addEntry(s, { type: "expense", amount: 35, category: "餐饮", accountId: wallet.id, occurredAt: "2026-07-31T15:00:00.000Z" });
  await svc.addEntry(s, { type: "expense", amount: 20, category: "超市", accountId: wallet.id, occurredAt: "2026-07-31T17:00:00.000Z" });
  await svc.addEntry(s, { type: "income", amount: 500, category: "工资", accountId: wallet.id, occurredAt: "2026-08-05T02:00:00.000Z" });

  const july = svc.summarizeLedger(s, ledgerId, "2026-07");
  assert.equal(july.month, "2026-07");
  assert.equal(july.expenseCents, 13500);
  assert.equal(july.incomeCents, 0);
  assert.equal(july.netCents, -13500);
  assert.deepEqual(july.expenseByCategory, [{ category: "餐饮", amountCents: 13500 }]);

  const august = svc.summarizeLedger(s, ledgerId, "2026-08");
  assert.equal(august.expenseCents, 2000);
  assert.equal(august.incomeCents, 50000);
  assert.equal(august.entryCount, 2);
  assert.equal(august.accounts.find((x) => x.id === wallet.id)!.balanceCents, 34500); // 500 - 135 - 20
});

test("occurredAt must be a valid ISO timestamp", async () => {
  const a = requireProfileContext("profile-a");
  await assert.rejects(
    () => svc.addEntry(a, { type: "expense", amount: 1, category: "测试", occurredAt: "not-a-time" }),
    /invalid ISO timestamp/,
  );
});

test("transfer shape and toAccountId symmetry fail with clear errors", async () => {
  const a = requireProfileContext("profile-a");
  await assert.rejects(
    () => svc.addEntry(a, { type: "transfer", amount: 1 }),
    /transfer requires accountId and toAccountId/,
  );
  await assert.rejects(
    () => svc.addEntry(a, { type: "transfer", amount: 1, accountId: "acc-ghost" }),
    /transfer requires accountId and toAccountId/,
  );
  for (const type of ["expense", "income"] as const) {
    await assert.rejects(
      () => svc.addEntry(a, { type, amount: 1, category: "测试", toAccountId: "acc-ghost" }),
      /toAccountId only applies to transfer entries/,
    );
  }
});

test("category is trimmed before storage and matches exact filter", async () => {
  const a = requireProfileContext("profile-a");
  const entry = await svc.addEntry(a, { type: "expense", amount: 1, category: "  餐饮  " });
  assert.equal(entry.category, "餐饮");
  assert.equal(svc.listEntries(a, undefined, { category: "餐饮" }).some((e) => e.id === entry.id), true);
});

test("listEntries tolerates non-finite limit/offset instead of SQL error", async () => {
  const a = requireProfileContext("profile-a");
  const rows = svc.listEntries(a, undefined, { limit: Number.NaN, offset: Number.NaN });
  assert.equal(Array.isArray(rows), true);
  assert.ok(rows.length <= 50);
});

test("L11: schema and service reject amounts above 9e12 yuan to keep cents within safe integer range", async () => {
  const a = requireProfileContext("profile-a");
  // schema 层：9e12 元恰好允许，再多 1 元拒绝
  assert.equal(amountYuanSchema.safeParse(MAX_AMOUNT_YUAN).success, true);
  assert.equal(amountYuanSchema.safeParse(MAX_AMOUNT_YUAN + 1).success, false);
  assert.equal(amountYuanSchema.safeParse(MAX_AMOUNT_YUAN + 0.01).success, false);
  // service 层（绕过工具 schema 直连）：addEntry 与 createAccount 都拒绝超限
  await assert.rejects(
    () => svc.addEntry(a, { type: "expense", amount: MAX_AMOUNT_YUAN + 1, category: "测试" }),
    /amount must be at most 9000000000000 yuan/,
  );
  await assert.rejects(
    () => svc.createAccount(a, { name: "超大余额", initialBalance: MAX_AMOUNT_YUAN + 1 }),
    /amount must be at most 9000000000000 yuan/,
  );
  // 上限金额本身可用，且分值精确表示
  const ok = await svc.addEntry(a, { type: "expense", amount: MAX_AMOUNT_YUAN, category: "测试" });
  assert.equal(ok.amountCents, MAX_AMOUNT_YUAN * 100);
});

test("L12: entry_update empty category clears it and empty note normalizes to NULL", async () => {
  const a = requireProfileContext("profile-a");
  const entry = await svc.addEntry(a, { type: "expense", amount: 5, category: "餐饮", note: "午饭" });
  // 空串/全空白分类与备注都被归一为“无”
  const cleared = await svc.updateEntry(a, entry.ledgerId, entry.id, { version: entry.version, category: " ", note: " " });
  assert.equal(cleared.category, undefined);
  assert.equal(cleared.note, undefined);
  const row = db.prepare("SELECT category, note FROM ledger_entries WHERE id = ?").get(entry.id) as {
    category: unknown;
    note: unknown;
  };
  assert.equal(row.category, null);
  assert.equal(row.note, null);
  // addEntry 也把空串备注归一为 NULL
  const emptyNote = await svc.addEntry(a, { type: "income", amount: 1, category: "测试", note: "" });
  assert.equal(emptyNote.note, undefined);
});

test("L16: deleting an already-deleted entry reports not-found instead of a version conflict", async () => {
  const a = requireProfileContext("profile-a");
  const entry = await svc.addEntry(a, { type: "expense", amount: 3, category: "删除测试" });
  await svc.deleteEntry(a, entry.ledgerId, entry.id, entry.version);
  await assert.rejects(
    () => svc.deleteEntry(a, entry.ledgerId, entry.id, entry.version),
    /entry not found/i,
  );
});

test("L17: updateAccount rejects blank or whitespace-only names instead of silently keeping the old one", async () => {
  const a = requireProfileContext("profile-a");
  const account = await svc.createAccount(a, { name: "改名测试" });
  assert.throws(() => svc.updateAccount(a, account.id, { name: "   " }), /account name is required and must not be blank/i);
  assert.throws(() => svc.updateAccount(a, account.id, { name: "" }), /account name is required and must not be blank/i);
  // 拒绝后名称保持原样
  assert.equal(svc.listAccounts(a).find((x) => x.id === account.id)!.name, "改名测试");
  const renamed = svc.updateAccount(a, account.id, { name: "改名成功" });
  assert.equal(renamed.name, "改名成功");
  assert.equal(renamed.version, 2);
});
