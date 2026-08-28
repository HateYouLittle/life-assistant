import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-bk-shared-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";
process.env.LIFE_ASSISTANT_TIMEZONE = "Asia/Shanghai";

const { requireProfileContext } = await import("../src/core/profile.js");
const { getDatabase } = await import("../src/core/database.js");
const svc = await import("../src/modules/bookkeeping/service.js");

const db = getDatabase();

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const a = () => requireProfileContext("profile-a");
const b = () => requireProfileContext("profile-b");
const c = () => requireProfileContext("profile-c");

test("shared ledger lifecycle: owner auto-membership and member management", () => {
  const ledger = svc.createSharedLedger(a(), "家庭账本");
  assert.equal(ledger.type, "shared");
  assert.equal(ledger.ownerProfileId, "profile-a");

  const aViews = svc.listLedgers(a());
  const aView = aViews.find((v) => v.id === ledger.id)!;
  assert.equal(aView.role, "owner");
  assert.equal(aView.memberCount, 1);

  // 非法 profileId 拒绝
  assert.throws(() => svc.addLedgerMember(a(), ledger.id, "bad id!"), /invalid profileId/i);
  // 非 owner 不能管理成员（b 还不是成员 → not found）
  assert.throws(() => svc.addLedgerMember(b(), ledger.id, "profile-c"), /not found|only the ledger owner/i);

  const member = svc.addLedgerMember(a(), ledger.id, "profile-b");
  assert.equal(member.role, "member");
  // 重复添加幂等
  assert.equal(svc.addLedgerMember(a(), ledger.id, "profile-b").profileId, "profile-b");
  assert.equal(svc.listLedgers(b()).find((v) => v.id === ledger.id)!.role, "member");

  // 不能移除 owner 本人
  assert.throws(() => svc.removeLedgerMember(a(), ledger.id, "profile-a"), /cannot remove the ledger owner/i);
  // 移除后立即失去可见性
  svc.removeLedgerMember(a(), ledger.id, "profile-b");
  assert.equal(svc.listLedgers(b()).some((v) => v.id === ledger.id), false);
  assert.throws(() => svc.listEntries(b(), ledger.id), /ledger not found/i);
  // 恢复成员关系供后续用例使用
  svc.addLedgerMember(a(), ledger.id, "profile-b");
});

test("shared accounts are owner-managed but member-writable", async () => {
  const ledger = svc.createSharedLedger(a(), "共享账户管理");
  svc.addLedgerMember(a(), ledger.id, "profile-b");

  // member 不能创建共享账户
  assert.throws(() => svc.createAccount(b(), { name: "私建", ledgerId: ledger.id }), /only the ledger owner/i);
  // 非成员不可见（not found，不泄露存在性）
  assert.throws(() => svc.createAccount(c(), { name: "外人", ledgerId: ledger.id }), /shared ledger not found/i);

  const pool = svc.createAccount(a(), { name: "家庭公共资金池", type: "alipay", initialBalance: 1000, ledgerId: ledger.id });
  assert.equal(pool.kind, "shared");
  assert.equal(pool.ownerProfileId, undefined);
  assert.equal(pool.ledgerId, ledger.id);
  assert.equal(pool.balanceCents, 100000);

  // 期初流水落在共享账本，成员可见
  const bEntries = svc.listEntries(b(), ledger.id);
  assert.equal(bEntries.length, 1);
  assert.equal(bEntries[0].category, "期初余额");

  // member 可以用共享账户记账
  const entry = await svc.addEntry(b(), { type: "expense", amount: 88.8, category: "家用", accountId: pool.id });
  assert.equal(entry.ledgerId, ledger.id);
  // owner 与 member 都能看到这条流水
  assert.equal(svc.getEntry(a(), ledger.id, entry.id).amountCents, 8880);
  assert.equal(svc.listAccounts(b(), ledger.id).find((x) => x.id === pool.id)!.balanceCents, 100000 - 8880);

  // 共享账户改/删仅 owner
  assert.throws(() => svc.updateAccount(b(), pool.id, { name: "改名" }), /only the ledger owner/i);
  assert.throws(() => svc.deleteAccount(b(), pool.id), /only the ledger owner/i);
  assert.throws(() => svc.deleteAccount(a(), pool.id), /archive it instead/i);
  const renamed = svc.updateAccount(a(), pool.id, { name: "家庭金库" });
  assert.equal(renamed.name, "家庭金库");
});

test("entry write permissions: member edits own only, owner edits anyone's", async () => {
  const ledger = svc.createSharedLedger(a(), "权限测试账本");
  svc.addLedgerMember(a(), ledger.id, "profile-b");
  const pool = svc.createAccount(a(), { name: "权限资金池", ledgerId: ledger.id });

  const byA = await svc.addEntry(a(), { type: "expense", amount: 10, category: "A的", accountId: pool.id });
  const byB = await svc.addEntry(b(), { type: "expense", amount: 20, category: "B的", accountId: pool.id });

  // b 只能改/删自己的流水
  await assert.rejects(
    () => svc.updateEntry(b(), ledger.id, byA.id, { version: byA.version, amount: 11 }),
    /only the recorder or the ledger owner/i,
  );
  await assert.rejects(() => svc.deleteEntry(b(), ledger.id, byA.id, byA.version), /only the recorder or the ledger owner/i);
  const ownEdit = await svc.updateEntry(b(), ledger.id, byB.id, { version: byB.version, amount: 21 });
  assert.equal(ownEdit.amountCents, 2100);

  // owner（非记录人）可以改/删任何人的流水
  const ownerEdit = await svc.updateEntry(a(), ledger.id, byB.id, { version: ownEdit.version, note: "owner 改的" });
  assert.equal(ownerEdit.note, "owner 改的");
  const ownerDelete = await svc.deleteEntry(a(), ledger.id, byB.id, ownerEdit.version);
  assert.equal(ownerDelete.id, byB.id);

  // 非成员完全不可见/不可写
  await assert.rejects(() => svc.addEntry(c(), { type: "expense", amount: 1, category: "外人", accountId: pool.id }), /account not found/i);
  assert.throws(() => svc.listEntries(c(), ledger.id), /ledger not found/i);
  assert.throws(() => svc.getEntry(c(), ledger.id, byA.id), /ledger not found/i);
});

test("cross-ledger transfer attribution follows the plan rules", async () => {
  const ledger = svc.createSharedLedger(a(), "跨账本转账");
  svc.addLedgerMember(a(), ledger.id, "profile-b");
  const pool = svc.createAccount(a(), { name: "转账资金池", initialBalance: 500, ledgerId: ledger.id });
  const personal = svc.createAccount(a(), { name: "转账个人钱包", initialBalance: 300 });

  // 个人 → 共享：恰一端共享 → 记入共享账本（全员可见）
  const t1 = await svc.addEntry(a(), { type: "transfer", amount: 100, accountId: personal.id, toAccountId: pool.id });
  assert.equal(t1.ledgerId, ledger.id);
  assert.equal(svc.listEntries(b(), ledger.id).some((e) => e.id === t1.id), true);
  assert.equal(svc.listAccounts(a(), ledger.id).find((x) => x.id === pool.id)!.balanceCents, 60000);
  assert.equal(svc.listAccounts(a()).find((x) => x.id === personal.id)!.balanceCents, 20000);

  // 共享 → 个人：仍记入共享账本；转入端必须是 b 自己的个人账户
  const bWallet = svc.createAccount(b(), { name: "b 的个人钱包" });
  const t2 = await svc.addEntry(b(), { type: "transfer", amount: 50, accountId: pool.id, toAccountId: bWallet.id });
  assert.equal(t2.ledgerId, ledger.id);

  // 两个个人账户互转 → 记录人个人账本，共享账本看不到
  const otherPersonal = svc.createAccount(a(), { name: "转账个人银行卡" });
  const t3 = await svc.addEntry(a(), { type: "transfer", amount: 25, accountId: personal.id, toAccountId: otherPersonal.id });
  assert.equal(t3.ledgerId, svc.ensurePersonalLedger(a()).id);
  assert.equal(svc.listEntries(b(), ledger.id).some((e) => e.id === t3.id), false);
  const accounts = svc.listAccounts(a());
  assert.equal(accounts.find((x) => x.id === personal.id)!.balanceCents, 17500); // 300 - 100 - 25（t2 的 50 进了 b 的钱包）
  assert.equal(accounts.find((x) => x.id === otherPersonal.id)!.balanceCents, 2500);
  assert.equal(svc.listAccounts(b()).find((x) => x.id === bWallet.id)!.balanceCents, 5000);

  // b 不能把 a 的个人账户用作转账任何一端
  await assert.rejects(
    () => svc.addEntry(b(), { type: "transfer", amount: 1, accountId: personal.id, toAccountId: bWallet.id }),
    /account not found: /,
  );
});

test("profiles A and B keep isolated personal books while sharing one ledger", async () => {
  const ledger = svc.createSharedLedger(a(), "隔离验证账本");
  svc.addLedgerMember(a(), ledger.id, "profile-b");
  const pool = svc.createAccount(a(), { name: "隔离资金池", ledgerId: ledger.id });

  const aLedgerId = svc.ensurePersonalLedger(a()).id;
  const bLedgerId = svc.ensurePersonalLedger(b()).id;
  assert.notEqual(aLedgerId, bLedgerId);

  await svc.addEntry(a(), { type: "expense", amount: 5, category: "a 私房钱" });
  await svc.addEntry(b(), { type: "expense", amount: 7, category: "b 私房钱" });

  // 个人流水互不可见
  const aCats = svc.listEntries(a(), undefined).map((e) => e.category);
  const bCats = svc.listEntries(b(), undefined).map((e) => e.category);
  assert.equal(aCats.includes("b 私房钱"), false);
  assert.equal(bCats.includes("a 私房钱"), false);

  // 共享账户流水双方可见
  await svc.addEntry(a(), { type: "income", amount: 9, category: "共同收入", accountId: pool.id });
  assert.equal(svc.getEntry(b(), ledger.id, svc.listEntries(a(), ledger.id)[0].id).amountCents, 900);

  // summary 默认各看各的个人账本
  assert.equal(svc.summarizeLedger(a()).expenseCents, 500);
  assert.equal(svc.summarizeLedger(b()).expenseCents, 700);
});
