import crypto from "node:crypto";
import { DateTime } from "luxon";
import { getDatabase } from "../../core/database.js";
import { asProfileContext, isWellFormedId, type ProfileContext } from "../../core/profile.js";
import { config } from "../../config.js";
import { publishNotification } from "../../core/notification-publisher.js";
import { buildMonthlyReportNotification, buildSharedEntryNotification, type SharedEntryAction } from "./notification.js";
import { MAX_AMOUNT_YUAN } from "./types.js";
import type {
  AccountBalanceView,
  AccountCreateInput,
  AccountType,
  AccountUpdateInput,
  CategoryTotal,
  EntryAddInput,
  EntryListOptions,
  EntryType,
  EntryUpdateInput,
  AccountView,
  Ledger,
  LedgerAccount,
  LedgerEntry,
  LedgerMember,
  LedgerRole,
  LedgerType,
  LedgerView,
  MonthlyReportData,
  MonthlyReportSharedPart,
  SummaryView,
} from "./types.js";

// ---------------------------------------------------------------------------
// 约定：金额一律以分（整数）存储与计算，工具入参/出参的元仅在工具层转换；
// 时间一律 UTC ISO 字符串；余额永不落库，由 ledger_entries 实时聚合。
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

/** 元 → 分：拒绝非有限数、非正数、超过 9e12 元（分值超出安全整数范围）与两位以上小数（浮点噪声容忍 1e-6）。 */
function toCents(amount: number): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new Error("amount must be a finite number (unit: yuan)");
  }
  const cents = Math.round(amount * 100);
  if (cents <= 0) throw new Error("amount must be greater than 0");
  if (cents > MAX_AMOUNT_YUAN * 100) {
    throw new Error(`amount must be at most ${MAX_AMOUNT_YUAN} yuan`);
  }
  if (Math.abs(amount * 100 - cents) >= 1e-6) throw new Error("amount supports at most 2 decimal places");
  return cents;
}

/** 归一化为 UTC ISO（定宽毫秒），保证 SQL 字符串比较与按月切分可靠。 */
function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) throw new Error(`invalid ISO timestamp: ${value}`);
  return parsed.toUTC().toISO()!;
}

function currentMonthKey(timezone: string = config.timezone): string {
  return DateTime.now().setZone(timezone).toFormat("yyyy-LL");
}

function previousMonthKey(at: Date, timezone: string = config.timezone): string {
  return DateTime.fromJSDate(at, { zone: "utc" }).setZone(timezone).startOf("month").minus({ months: 1 }).toFormat("yyyy-LL");
}

/** 自然月 → [start, end) UTC ISO 边界（按 config.timezone 切）。 */
function monthRange(month: string, timezone: string = config.timezone): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month must be yyyy-LL");
  const start = DateTime.fromFormat(month, "yyyy-LL", { zone: timezone }).startOf("month");
  return { start: start.toUTC().toISO()!, end: start.plus({ months: 1 }).toUTC().toISO()! };
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

function rowToLedger(row: Row): Ledger {
  return {
    id: row.id as string,
    type: row.type as LedgerType,
    name: row.name as string,
    ownerProfileId: row.owner_profile_id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToMember(row: Row): LedgerMember {
  return {
    ledgerId: row.ledger_id as string,
    profileId: row.profile_id as string,
    role: row.role as LedgerRole,
    joinedAt: row.joined_at as string,
  };
}

function rowToAccount(row: Row): LedgerAccount {
  return {
    id: row.id as string,
    kind: row.kind as "personal" | "shared",
    ownerProfileId: (row.owner_profile_id as string | null) ?? undefined,
    ledgerId: (row.ledger_id as string | null) ?? undefined,
    name: row.name as string,
    type: row.type as AccountType,
    archived: Number(row.archived) === 1,
    version: Number(row.version),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToEntry(row: Row): LedgerEntry {
  return {
    ledgerId: row.ledger_id as string,
    id: row.id as string,
    profileId: row.profile_id as string,
    type: row.type as EntryType,
    amountCents: Number(row.amount_cents),
    category: (row.category as string | null) ?? undefined,
    accountId: (row.account_id as string | null) ?? undefined,
    toAccountId: (row.to_account_id as string | null) ?? undefined,
    occurredAt: row.occurred_at as string,
    note: (row.note as string | null) ?? undefined,
    version: Number(row.version),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ---------------------------------------------------------------------------
// 账本与成员
// ---------------------------------------------------------------------------

function getLedgerRow(ledgerId: string): Row | undefined {
  return getDatabase().prepare("SELECT * FROM ledgers WHERE id = ?").get(ledgerId) as Row | undefined;
}

function getMembership(ledgerId: string, profileId: string): LedgerRole | undefined {
  const row = getDatabase()
    .prepare("SELECT role FROM ledger_members WHERE ledger_id = ? AND profile_id = ?")
    .get(ledgerId, profileId) as { role?: string } | undefined;
  return row?.role as LedgerRole | undefined;
}

/** 读访问：账本存在且当前 Profile 是成员（个人账本 owner 恒为成员行）。否则一律 not found，不泄露存在性。 */
function requireLedgerForRead(profile: ProfileContext, ledgerId: string): Ledger {
  const row = getLedgerRow(ledgerId);
  if (!row) throw new Error("ledger not found");
  if (!getMembership(ledgerId, profile.id)) throw new Error("ledger not found");
  return rowToLedger(row);
}

/** 共享账本 owner 访问：非成员 not found；成员但非 owner 明确拒绝。 */
function requireSharedOwner(profile: ProfileContext, ledgerId: string): Ledger {
  const row = getLedgerRow(ledgerId);
  if (!row || (row.type as LedgerType) !== "shared") throw new Error("shared ledger not found");
  const role = getMembership(ledgerId, profile.id);
  if (!role) throw new Error("shared ledger not found");
  if (role !== "owner") throw new Error("only the ledger owner can manage members and shared accounts");
  return rowToLedger(row);
}

/**
 * 个人账本懒创建：首次使用记账工具时建立（owner 同步写入 ledger_members）。
 * 个人账本 = 单成员账本，与共享账本共用同一套权限与流水代码。
 */
export function ensurePersonalLedger(value: ProfileContext | string, at: Date = new Date()): Ledger {
  const profile = asProfileContext(value);
  const db = getDatabase();
  const existing = db
    .prepare("SELECT * FROM ledgers WHERE type = 'personal' AND owner_profile_id = ?")
    .get(profile.id) as Row | undefined;
  if (existing) return rowToLedger(existing);

  // 读-判-写包裹在写事务里，避免多进程首次并发时创建出两个个人账本。
  db.exec("BEGIN IMMEDIATE");
  try {
    const raced = db
      .prepare("SELECT * FROM ledgers WHERE type = 'personal' AND owner_profile_id = ?")
      .get(profile.id) as Row | undefined;
    if (raced) {
      db.exec("COMMIT");
      return rowToLedger(raced);
    }
    const ts = at.toISOString();
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO ledgers(id, type, name, owner_profile_id, created_at, updated_at) VALUES(?, 'personal', ?, ?, ?, ?)",
    ).run(id, "个人账本", profile.id, ts, ts);
    db.prepare(
      "INSERT INTO ledger_members(ledger_id, profile_id, role, joined_at) VALUES(?, ?, 'owner', ?)",
    ).run(id, profile.id, ts);
    db.exec("COMMIT");
    return rowToLedger(db.prepare("SELECT * FROM ledgers WHERE id = ?").get(id) as Row);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listLedgers(value: ProfileContext | string): LedgerView[] {
  const profile = asProfileContext(value);
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT l.*, m.role AS caller_role,
      (SELECT COUNT(*) FROM ledger_members lm WHERE lm.ledger_id = l.id) AS member_count
    FROM ledgers l
    JOIN ledger_members m ON m.ledger_id = l.id AND m.profile_id = ?
    ORDER BY l.created_at, l.id
  `).all(profile.id) as Row[];
  return rows.map((row) => {
    const ledger = rowToLedger(row);
    const accounts = accountsOfLedger(ledger);
    return {
      id: ledger.id,
      type: ledger.type,
      name: ledger.name,
      ownerProfileId: ledger.ownerProfileId,
      role: row.caller_role as LedgerRole,
      memberCount: Number(row.member_count),
      accountCount: accounts.length,
      totalBalanceCents: accounts.reduce((sum, account) => sum + account.balanceCents, 0),
      createdAt: ledger.createdAt,
    };
  });
}

/** 个人账本（type=personal）的账户按 owner 关联；共享账本账户按 ledger_id 关联。 */
function accountsOfLedger(ledger: Ledger): AccountView[] {
  const db = getDatabase();
  const rows = ledger.type === "personal"
    ? db.prepare("SELECT * FROM ledger_accounts WHERE kind = 'personal' AND owner_profile_id = ? ORDER BY created_at, id")
        .all(ledger.ownerProfileId) as Row[]
    : db.prepare("SELECT * FROM ledger_accounts WHERE ledger_id = ? ORDER BY created_at, id").all(ledger.id) as Row[];
  return rows.map((row) => withBalance(rowToAccount(row)));
}

export function createSharedLedger(value: ProfileContext | string, name: string, at: Date = new Date()): Ledger {
  const profile = asProfileContext(value);
  const trimmed = name.trim();
  if (!trimmed) throw new Error("ledger name is required");
  const db = getDatabase();
  const ts = at.toISOString();
  const id = crypto.randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO ledgers(id, type, name, owner_profile_id, created_at, updated_at) VALUES(?, 'shared', ?, ?, ?, ?)",
    ).run(id, trimmed, profile.id, ts, ts);
    db.prepare(
      "INSERT INTO ledger_members(ledger_id, profile_id, role, joined_at) VALUES(?, ?, 'owner', ?)",
    ).run(id, profile.id, ts);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rowToLedger(getLedgerRow(id)!);
}

export function addLedgerMember(
  value: ProfileContext | string,
  ledgerId: string,
  memberProfileId: string,
  at: Date = new Date(),
): LedgerMember {
  const profile = asProfileContext(value);
  requireSharedOwner(profile, ledgerId);
  if (!isWellFormedId(memberProfileId)) throw new Error(`invalid profileId: ${memberProfileId}`);
  const db = getDatabase();
  const existing = db.prepare("SELECT * FROM ledger_members WHERE ledger_id = ? AND profile_id = ?")
    .get(ledgerId, memberProfileId) as Row | undefined;
  if (existing) return rowToMember(existing);
  db.prepare("INSERT INTO ledger_members(ledger_id, profile_id, role, joined_at) VALUES(?, ?, 'member', ?)")
    .run(ledgerId, memberProfileId, at.toISOString());
  return rowToMember(
    db.prepare("SELECT * FROM ledger_members WHERE ledger_id = ? AND profile_id = ?")
      .get(ledgerId, memberProfileId) as Row,
  );
}

export function removeLedgerMember(value: ProfileContext | string, ledgerId: string, memberProfileId: string): void {
  const profile = asProfileContext(value);
  const ledger = requireSharedOwner(profile, ledgerId);
  if (memberProfileId === ledger.ownerProfileId) throw new Error("cannot remove the ledger owner");
  const result = getDatabase()
    .prepare("DELETE FROM ledger_members WHERE ledger_id = ? AND profile_id = ?")
    .run(ledgerId, memberProfileId);
  if (result.changes === 0) throw new Error("member not found in this ledger");
}

// ---------------------------------------------------------------------------
// 账户与余额（余额 = 流水派生，跨账本聚合，见方案 §3）
// ---------------------------------------------------------------------------

const BALANCE_SQL = `SELECT COALESCE(SUM(CASE
  WHEN type = 'income'   AND account_id = ?  THEN amount_cents
  WHEN type = 'expense'  AND account_id = ?  THEN -amount_cents
  WHEN type = 'transfer' AND account_id = ?  THEN -amount_cents
  WHEN type = 'transfer' AND to_account_id = ? THEN amount_cents
  ELSE 0 END), 0) AS balance_cents
FROM ledger_entries WHERE account_id = ? OR to_account_id = ?`;

export function accountBalanceCents(accountId: string): number {
  const row = getDatabase().prepare(BALANCE_SQL).get(accountId, accountId, accountId, accountId, accountId, accountId) as {
    balance_cents: number | bigint;
  };
  return Number(row.balance_cents);
}

function withBalance(account: LedgerAccount): AccountView {
  return { ...account, balanceCents: accountBalanceCents(account.id) };
}

function getAccountRow(accountId: string): LedgerAccount | undefined {
  const row = getDatabase().prepare("SELECT * FROM ledger_accounts WHERE id = ?").get(accountId) as Row | undefined;
  return row ? rowToAccount(row) : undefined;
}

/** 写/改账户访问：个人账户仅本人；共享账户仅账本 owner。不可见一律 not found。 */
function requireAccountForAdmin(profile: ProfileContext, accountId: string): LedgerAccount {
  const account = getAccountRow(accountId);
  if (!account) throw new Error("account not found");
  if (account.kind === "personal") {
    if (account.ownerProfileId !== profile.id) throw new Error("account not found");
    return account;
  }
  const role = getMembership(account.ledgerId!, profile.id);
  if (!role) throw new Error("account not found");
  if (role !== "owner") throw new Error("only the ledger owner can manage shared accounts");
  return account;
}

export async function createAccount(value: ProfileContext | string, input: AccountCreateInput, at: Date = new Date()): Promise<AccountView> {
  const profile = asProfileContext(value);
  const name = input.name.trim();
  if (!name) throw new Error("account name is required");
  let kind: "personal" | "shared";
  let ownerProfileId: string | null;
  let ledgerId: string | null;
  if (input.ledgerId !== undefined) {
    requireSharedOwner(profile, input.ledgerId);
    kind = "shared";
    ownerProfileId = null;
    ledgerId = input.ledgerId;
  } else {
    kind = "personal";
    ownerProfileId = profile.id;
    ledgerId = null;
  }
  const db = getDatabase();
  const ts = at.toISOString();
  const id = crypto.randomUUID();
  // 期初流水与账户行同一事务落库；个人账本懒创建自带事务，须放在 BEGIN 之前解析。
  const opening = input.initialBalance !== undefined
    ? {
        ledgerId: kind === "shared" ? ledgerId! : ensurePersonalLedger(profile).id,
        amountCents: toCents(input.initialBalance),
        entryId: crypto.randomUUID(),
      }
    : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO ledger_accounts(id, kind, owner_profile_id, ledger_id, name, type, archived, version, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
    `).run(id, kind, ownerProfileId, ledgerId, name, input.type ?? "other", ts, ts);
    if (opening) {
      // 期初余额 = 一条「期初余额」收入流水，余额口径与普通流水完全一致。
      insertEntryRow({
        ledgerId: opening.ledgerId,
        id: opening.entryId,
        profileId: profile.id,
        type: "income",
        amountCents: opening.amountCents,
        category: "期初余额",
        accountId: id,
        toAccountId: null,
        occurredAt: ts,
        note: null,
        version: 1,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // 共享账户的期初流水对其他成员可见但此前不产生任何动态：补发与普通记账
  // 同路径的 add 通知（除创建者外的成员各一条），避免余额凭空增加（M10）。
  if (opening && kind === "shared") {
    const openingEntry = getEntryRow(opening.ledgerId, opening.entryId)!;
    await notifySharedEntryChange("add", openingEntry, profile.id);
  }
  return withBalance(getAccountRow(id)!);
}

export function listAccounts(value: ProfileContext | string, ledgerId?: string): AccountView[] {
  const profile = asProfileContext(value);
  if (ledgerId !== undefined) {
    // 个人账本的账户按 owner 关联（ledger_id 为 NULL），共享账本按 ledger_id 关联。
    const ledger = requireLedgerForRead(profile, ledgerId);
    return accountsOfLedger(ledger);
  }
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM ledger_accounts
    WHERE (kind = 'personal' AND owner_profile_id = ?)
       OR (kind = 'shared' AND ledger_id IN (SELECT ledger_id FROM ledger_members WHERE profile_id = ?))
    ORDER BY created_at, id
  `).all(profile.id, profile.id) as Row[];
  return rows.map((row) => withBalance(rowToAccount(row)));
}

export function updateAccount(
  value: ProfileContext | string,
  accountId: string,
  changes: AccountUpdateInput,
  at: Date = new Date(),
): AccountView {
  const profile = asProfileContext(value);
  const account = requireAccountForAdmin(profile, accountId);
  // 显式拒绝空/全空白名称，避免静默回退旧名让用户误以为改名成功（L17）。
  if (changes.name !== undefined) {
    const trimmedName = changes.name.trim();
    if (!trimmedName) throw new Error("account name is required and must not be blank");
  }
  const merged = {
    name: changes.name !== undefined ? changes.name.trim() : account.name,
    type: changes.type ?? account.type,
    archived: changes.archived ?? account.archived,
  };
  getDatabase().prepare(
    "UPDATE ledger_accounts SET name = ?, type = ?, archived = ?, version = version + 1, updated_at = ? WHERE id = ?",
  ).run(merged.name, merged.type, merged.archived ? 1 : 0, at.toISOString(), account.id);
  return withBalance(getAccountRow(account.id)!);
}

export function deleteAccount(value: ProfileContext | string, accountId: string): void {
  const profile = asProfileContext(value);
  const account = requireAccountForAdmin(profile, accountId);
  const db = getDatabase();
  const refs = db.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE account_id = ? OR to_account_id = ?")
    .get(account.id, account.id) as { count: number };
  if (Number(refs.count) > 0) {
    throw new Error("account still has entries; archive it instead (account_update with archived: true)");
  }
  db.prepare("DELETE FROM ledger_accounts WHERE id = ?").run(account.id);
}

// ---------------------------------------------------------------------------
// 流水
// ---------------------------------------------------------------------------

function insertEntryRow(entry: {
  ledgerId: string;
  id: string;
  profileId: string;
  type: EntryType;
  amountCents: number;
  category: string | null;
  accountId: string | null;
  toAccountId: string | null;
  occurredAt: string;
  note: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}): void {
  getDatabase().prepare(`
    INSERT INTO ledger_entries(
      ledger_id, id, profile_id, type, amount_cents, category,
      account_id, to_account_id, occurred_at, note, version, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.ledgerId,
    entry.id,
    entry.profileId,
    entry.type,
    entry.amountCents,
    entry.category ?? null,
    entry.accountId ?? null,
    entry.toAccountId ?? null,
    entry.occurredAt,
    entry.note ?? null,
    entry.version,
    entry.createdAt,
    entry.updatedAt,
  );
}

function getEntryRow(ledgerId: string, entryId: string): LedgerEntry | undefined {
  const row = getDatabase().prepare("SELECT * FROM ledger_entries WHERE ledger_id = ? AND id = ?")
    .get(ledgerId, entryId) as Row | undefined;
  return row ? rowToEntry(row) : undefined;
}

/** 校验分类约定；allowMissing 时（更新路径）允许分类被清空（expense/income 传空串清除）。 */
function validateCategory(type: EntryType, category: string | undefined, options: { allowMissing?: boolean } = {}): void {
  if (type === "transfer") {
    if (category !== undefined && category.trim() !== "") {
      throw new Error("transfer entries must not have a category");
    }
    return;
  }
  if (!options.allowMissing && (category === undefined || category.trim() === "")) {
    throw new Error(`category is required for ${type} entries`);
  }
}

/** 记账用的账户访问：个人账户仅 owner；共享账户该账本任意成员。不可见一律 not found。 */
function requireAccountForEntry(profile: ProfileContext, accountId: string): LedgerAccount {
  const account = getAccountRow(accountId);
  if (!account) throw new Error(`account not found: ${accountId}`);
  if (account.kind === "personal") {
    if (account.ownerProfileId !== profile.id) throw new Error(`account not found: ${accountId}`);
    return account;
  }
  if (!getMembership(account.ledgerId!, profile.id)) throw new Error(`account not found: ${accountId}`);
  return account;
}

/** 流水归属规则（方案 §3）：决定 entry 落哪个账本。 */
function resolveEntryLedger(
  profile: ProfileContext,
  input: { type: EntryType; accountId?: string; toAccountId?: string },
): string {
  if (input.type === "transfer") {
    const source = requireAccountForEntry(profile, input.accountId!);
    const target = requireAccountForEntry(profile, input.toAccountId!);
    if (source.id === target.id) throw new Error("transfer requires two different accounts");
    // 恰一端为共享 → 该共享账本；两端皆共享 → 源账户账本；两端皆个人 → 记录人个人账本。
    if (source.kind === "shared") return source.ledgerId!;
    if (target.kind === "shared") return target.ledgerId!;
    return ensurePersonalLedger(profile).id;
  }
  if (input.accountId !== undefined) {
    const account = requireAccountForEntry(profile, input.accountId);
    if (account.kind === "shared") return account.ledgerId!;
  }
  return ensurePersonalLedger(profile).id;
}

export async function addEntry(value: ProfileContext | string, input: EntryAddInput, at: Date = new Date()): Promise<LedgerEntry> {
  const profile = asProfileContext(value);
  // 账户端点先于任何 SQL 校验：transfer 必须双端齐全，非 transfer 禁带 toAccountId。
  if (input.type === "transfer") {
    if (input.accountId === undefined || input.toAccountId === undefined) {
      throw new Error("transfer requires accountId and toAccountId");
    }
  } else if (input.toAccountId !== undefined) {
    throw new Error("toAccountId only applies to transfer entries");
  }
  validateCategory(input.type, input.category);
  const amountCents = toCents(input.amount);
  const occurredAt = normalizeTimestamp(input.occurredAt, at.toISOString());
  const ledgerId = resolveEntryLedger(profile, input);
  const id = crypto.randomUUID();
  insertEntryRow({
    ledgerId,
    id,
    profileId: profile.id,
    type: input.type,
    amountCents,
    category: input.category?.trim() || null,
    accountId: input.accountId ?? null,
    toAccountId: input.toAccountId ?? null,
    occurredAt,
    // 空串/全空白备注归一为 NULL，避免与「无备注」产生两种等价表示（L12）。
    note: input.note && input.note.trim() ? input.note : null,
    version: 1,
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
  });
  const entry = getEntryRow(ledgerId, id)!;
  await notifySharedEntryChange("add", entry, profile.id);
  return entry;
}

export function listEntries(
  value: ProfileContext | string,
  ledgerId: string | undefined,
  options: EntryListOptions = {},
): LedgerEntry[] {
  const profile = asProfileContext(value);
  const target = ledgerId ?? ensurePersonalLedger(profile).id;
  requireLedgerForRead(profile, target);
  const clauses = ["ledger_id = ?"];
  const values: string[] = [target];
  if (options.type) { clauses.push("type = ?"); values.push(options.type); }
  if (options.category) { clauses.push("category = ?"); values.push(options.category); }
  if (options.from !== undefined) { clauses.push("occurred_at >= ?"); values.push(normalizeTimestamp(options.from, options.from)); }
  if (options.to !== undefined) { clauses.push("occurred_at <= ?"); values.push(normalizeTimestamp(options.to, options.to)); }
  // Number.isFinite 兜底：NaN 会穿透 Math.min/Math.max 链，拼进 SQL 直接变成语法错误。
  const rawLimit = options.limit ?? 50;
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50, 1), 500);
  const rawOffset = options.offset ?? 0;
  const offset = Math.max(Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0, 0);
  const rows = getDatabase().prepare(
    `SELECT * FROM ledger_entries WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC, created_at DESC LIMIT ${limit} OFFSET ${offset}`,
  ).all(...values) as Row[];
  return rows.map(rowToEntry);
}

export function getEntry(value: ProfileContext | string, ledgerId: string, entryId: string): LedgerEntry {
  const profile = asProfileContext(value);
  requireLedgerForRead(profile, ledgerId);
  const entry = getEntryRow(ledgerId, entryId);
  if (!entry) throw new Error("entry not found");
  return entry;
}

/** 改/删流水：记录人本人，或共享账本 owner（可改删任何人的）；个人账本 owner 即记录人。 */
function requireEntryForWrite(profile: ProfileContext, entry: LedgerEntry, ledger: Ledger): void {
  if (entry.profileId === profile.id) return;
  if (ledger.type === "shared" && ledger.ownerProfileId === profile.id) return;
  throw new Error("only the recorder or the ledger owner can modify this entry");
}

function versionConflictError(entryId: string, expected: number, current: number): Error {
  return new Error(`entry version conflict: current version is ${current}, expected version ${expected}; refetch the entry and retry`);
}

/**
 * 共享账本写路径的成员动态通知：对除记录人外的每个成员各发一条 profile scope
 * 信封（未配推送路由的成员走 notify.pull 拉取）。通知账本集合按流水账户端点
 * 推导（extraLedgerIds 供流水改挂账本时补传原账本）：转账两端分属不同共享账本
 * 时两端成员都通知，避免「余额变了/流水消失却无人知晓」。通知失败记录日志继续，
 * 不回滚已落库的记账（对齐 schedule/tick 的容错风格）。
 */
/**
 * 共享账本写路径的成员动态通知：对除记录人外的每个成员各发一条 profile scope
 * 信封（未配推送路由的成员走 notify.pull 拉取）。通知账本集合按流水账户端点
 * 推导（extraLedgerIds 供流水改挂账本时补传原账本）：转账两端分属不同共享账本
 * 时两端成员都通知，避免「余额变了/流水消失却无人知晓」。通知失败记录日志继续，
 * 不回滚已落库的记账（对齐 schedule/tick 的容错风格）。
 * previous 供 update 携带变更前的账户/账本信息，作为成员通知的留痕（M2/L14）。
 */
async function notifySharedEntryChange(
  action: SharedEntryAction,
  entry: LedgerEntry,
  actorProfileId: string,
  extraLedgerIds: string[] = [],
  previous?: Pick<LedgerEntry, "ledgerId" | "accountId" | "toAccountId">,
): Promise<void> {
  const ledgerIds = new Set<string>([entry.ledgerId, ...extraLedgerIds]);
  for (const accountId of [entry.accountId, entry.toAccountId]) {
    if (accountId === undefined) continue;
    const account = getAccountRow(accountId);
    if (account?.kind === "shared") ledgerIds.add(account.ledgerId!);
  }
  const accounts = entryAccounts(entry);
  for (const ledgerId of ledgerIds) {
    const ledgerRow = getLedgerRow(ledgerId);
    if (!ledgerRow || (ledgerRow.type as LedgerType) !== "shared") continue;
    const ledger = rowToLedger(ledgerRow);
    const members = getDatabase()
      .prepare("SELECT profile_id FROM ledger_members WHERE ledger_id = ?")
      .all(ledgerId) as Array<{ profile_id: string }>;
    for (const member of members) {
      if (member.profile_id === actorProfileId) continue;
      try {
        await publishNotification(buildSharedEntryNotification({
          profileId: member.profile_id,
          ledgerId: ledger.id,
          ledgerName: ledger.name,
          entry,
          action,
          actorProfileId,
          accounts,
          previous,
        }));
      } catch (error) {
        console.error(`[bookkeeping] shared entry notification failed for ${member.profile_id}:`, (error as Error).message);
      }
    }
  }
}

/** 流水端点账户及其所属共享账本（个人账户无账本）：通知 payload 的账户/账本信息（M1/L14）。 */
function entryAccounts(entry: LedgerEntry): {
  accountId?: string;
  toAccountId?: string;
  accountLedgerId?: string;
  toAccountLedgerId?: string;
} {
  const source = entry.accountId !== undefined ? getAccountRow(entry.accountId) : undefined;
  const target = entry.toAccountId !== undefined ? getAccountRow(entry.toAccountId) : undefined;
  return {
    accountId: entry.accountId,
    toAccountId: entry.toAccountId,
    accountLedgerId: source?.kind === "shared" ? source.ledgerId : undefined,
    toAccountLedgerId: target?.kind === "shared" ? target.ledgerId : undefined,
  };
}

export async function updateEntry(
  value: ProfileContext | string,
  ledgerId: string,
  entryId: string,
  changes: EntryUpdateInput,
  at: Date = new Date(),
): Promise<LedgerEntry> {
  const profile = asProfileContext(value);
  const ledger = requireLedgerForRead(profile, ledgerId);
  const entry = getEntryRow(ledgerId, entryId);
  if (!entry) throw new Error("entry not found");
  requireEntryForWrite(profile, entry, ledger);
  if (changes.toAccountId !== undefined && entry.type !== "transfer") {
    throw new Error("toAccountId only applies to transfer entries");
  }

  const merged = {
    type: entry.type,
    amountCents: changes.amount !== undefined ? toCents(changes.amount) : entry.amountCents,
    // 空串/全空白分类 → undefined（清空，落 NULL）；「用于清空」的分支在工具层放开空串后可达（L12）。
    category: changes.category !== undefined ? (changes.category.trim() || undefined) : entry.category,
    accountId: changes.accountId !== undefined ? changes.accountId : entry.accountId,
    toAccountId: entry.type === "transfer"
      ? (changes.toAccountId !== undefined ? changes.toAccountId : entry.toAccountId)
      : undefined,
    occurredAt: changes.occurredAt !== undefined ? normalizeTimestamp(changes.occurredAt, entry.occurredAt) : entry.occurredAt,
    // 空串/全空白备注归一为 undefined → 落 NULL（L12）。
    note: changes.note !== undefined ? (changes.note.trim() ? changes.note : undefined) : entry.note,
  };
  // 更新路径允许清空分类（创建仍要求 expense/income 分类必填）。
  validateCategory(merged.type, merged.category, { allowMissing: true });
  // 类型不可变（v1），transfer 恒双账户、expense/income 恒无 to 账户，归属重算只随账户变化。
  const destinationLedgerId = resolveEntryLedger(profile, merged);

  // 共享账本流水跨账本移出（改挂到其他账本）需 owner 权限：成员即使记录人本人，
  // 把共享流水改挂个人账户也会让共享余额整体静默变化（M2）。同账本内改账户不受影响。
  if (ledger.type === "shared" && destinationLedgerId !== ledgerId && ledger.ownerProfileId !== profile.id) {
    throw new Error("only the ledger owner can move a shared-ledger entry to another ledger");
  }

  const ts = at.toISOString();
  const result = getDatabase().prepare(`
    UPDATE ledger_entries SET
      amount_cents = ?, category = ?, account_id = ?, to_account_id = ?,
      occurred_at = ?, note = ?, ledger_id = ?, version = version + 1, updated_at = ?
    WHERE ledger_id = ? AND id = ? AND version = ?
  `).run(
    merged.amountCents,
    merged.category ?? null,
    merged.accountId ?? null,
    merged.toAccountId ?? null,
    merged.occurredAt,
    merged.note ?? null,
    destinationLedgerId,
    ts,
    ledgerId,
    entryId,
    changes.version,
  );
  if (result.changes === 0) {
    // 区分「条目已不存在（并发删除/被移出）」与「版本不匹配」两条路径（L16）。
    const stillThere = getEntryRow(ledgerId, entryId);
    if (!stillThere) throw new Error("entry not found: it was deleted or moved to another ledger concurrently");
    throw versionConflictError(entryId, changes.version, stillThere.version);
  }
  const updated = getEntryRow(destinationLedgerId, entryId)!;
  // 流水改挂到其他账本时原账本成员也通知，否则流水在他们那里「凭空消失」；
  // 同时携带变更前的账户/账本信息以供留痕（M2/L14）。
  await notifySharedEntryChange("update", updated, profile.id, ledgerId !== destinationLedgerId ? [ledgerId] : [], entry);
  return updated;
}

export async function deleteEntry(
  value: ProfileContext | string,
  ledgerId: string,
  entryId: string,
  version: number,
): Promise<LedgerEntry> {
  const profile = asProfileContext(value);
  const ledger = requireLedgerForRead(profile, ledgerId);
  const entry = getEntryRow(ledgerId, entryId);
  if (!entry) throw new Error("entry not found");
  requireEntryForWrite(profile, entry, ledger);
  const result = getDatabase()
    .prepare("DELETE FROM ledger_entries WHERE ledger_id = ? AND id = ? AND version = ?")
    .run(ledgerId, entryId, version);
  if (result.changes === 0) {
    // 区分「条目已不存在（并发删除）」与「版本不匹配」两条路径（L16）。
    const stillThere = getEntryRow(ledgerId, entryId);
    if (!stillThere) throw new Error("entry not found: it was deleted concurrently");
    throw versionConflictError(entryId, version, stillThere.version);
  }
  await notifySharedEntryChange("delete", entry, profile.id);
  return entry;
}

// ---------------------------------------------------------------------------
// 汇总与月度报表
// ---------------------------------------------------------------------------

function sumCategoryTotals(entries: LedgerEntry[], type: EntryType): CategoryTotal[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== type) continue;
    const key = entry.category ?? "未分类";
    totals.set(key, (totals.get(key) ?? 0) + entry.amountCents);
  }
  return [...totals.entries()]
    .map(([category, amountCents]) => ({ category, amountCents }))
    .sort((a, b) => b.amountCents - a.amountCents || a.category.localeCompare(b.category));
}

export function summarizeLedger(
  value: ProfileContext | string,
  ledgerId?: string,
  month?: string,
): SummaryView {
  const profile = asProfileContext(value);
  const target = ledgerId ?? ensurePersonalLedger(profile).id;
  const ledger = requireLedgerForRead(profile, target);
  const resolvedMonth = month ?? currentMonthKey();
  const { start, end } = monthRange(resolvedMonth);
  const entries = (getDatabase().prepare(
    "SELECT * FROM ledger_entries WHERE ledger_id = ? AND occurred_at >= ? AND occurred_at < ?",
  ).all(target, start, end) as Row[]).map(rowToEntry);
  const incomeCents = entries.filter((e) => e.type === "income").reduce((sum, e) => sum + e.amountCents, 0);
  const expenseCents = entries.filter((e) => e.type === "expense").reduce((sum, e) => sum + e.amountCents, 0);
  return {
    ledgerId: target,
    ledgerName: ledger.name,
    month: resolvedMonth,
    incomeCents,
    expenseCents,
    netCents: incomeCents - expenseCents,
    entryCount: entries.length,
    expenseByCategory: sumCategoryTotals(entries, "expense"),
    incomeByCategory: sumCategoryTotals(entries, "income"),
    accounts: listAccounts(profile, target).map((account): AccountBalanceView => ({
      id: account.id,
      name: account.name,
      type: account.type,
      kind: account.kind,
      archived: account.archived,
      balanceCents: account.balanceCents,
    })),
  };
}

/**
 * 组装单个 Profile 的上月报表数据（个人账本 + 各共享账本）。
 * 上月个人与共享账本均无流水时 hasData=false，job 跳过不推送。
 */
export function buildMonthlyReport(profileId: string, month: string): MonthlyReportData {
  const { start, end } = monthRange(month);
  const db = getDatabase();
  // floorAt 提供共享账本段按成员加入时间截断的下界（L15）：新成员不收到其加入之前的共享流水。
  const entriesIn = (ledgerId: string, floorAt?: string): LedgerEntry[] => {
    const rows = floorAt
      ? db.prepare(
          "SELECT * FROM ledger_entries WHERE ledger_id = ? AND occurred_at >= ? AND occurred_at < ? AND occurred_at >= ?",
        ).all(ledgerId, start, end, floorAt)
      : db.prepare("SELECT * FROM ledger_entries WHERE ledger_id = ? AND occurred_at >= ? AND occurred_at < ?")
          .all(ledgerId, start, end);
    return (rows as Row[]).map(rowToEntry);
  };

  const personalRow = db
    .prepare("SELECT * FROM ledgers WHERE type = 'personal' AND owner_profile_id = ?")
    .get(profileId) as Row | undefined;
  const personalEntries = personalRow ? entriesIn(personalRow.id as string) : [];
  const personalIncome = personalEntries.filter((e) => e.type === "income").reduce((s, e) => s + e.amountCents, 0);
  const personalExpense = personalEntries.filter((e) => e.type === "expense").reduce((s, e) => s + e.amountCents, 0);

  const sharedLedgers = (db.prepare(`
    SELECT l.*, m.joined_at AS caller_joined_at FROM ledgers l
    JOIN ledger_members m ON m.ledger_id = l.id AND m.profile_id = ?
    WHERE l.type = 'shared'
    ORDER BY l.created_at, l.id
  `).all(profileId) as Row[]).map((row): { ledger: Ledger; joinedAt: string } => ({
    ledger: rowToLedger(row),
    joinedAt: row.caller_joined_at as string,
  }));
  let sharedHasEntries = false;
  const shared: MonthlyReportSharedPart[] = sharedLedgers.map(({ ledger, joinedAt }) => {
    // 只统计该成员加入（joined_at）之后发生的流水；余额仍为当前实时值。
    const entries = entriesIn(ledger.id, joinedAt);
    if (entries.length > 0) sharedHasEntries = true;
    return {
      ledgerId: ledger.id,
      ledgerName: ledger.name,
      incomeCents: entries.filter((e) => e.type === "income").reduce((s, e) => s + e.amountCents, 0),
      expenseCents: entries.filter((e) => e.type === "expense").reduce((s, e) => s + e.amountCents, 0),
      balanceCents: accountsOfLedger(ledger).reduce((s, account) => s + account.balanceCents, 0),
    };
  });

  return {
    profileId,
    month,
    // 上月个人或任一共享账本有流水（含仅转账）才推送，无动态的 Profile 静默跳过。
    hasData: personalEntries.length > 0 || sharedHasEntries,
    personal: {
      incomeCents: personalIncome,
      expenseCents: personalExpense,
      netCents: personalIncome - personalExpense,
      topCategories: sumCategoryTotals(personalEntries, "expense").slice(0, 5),
    },
    shared,
  };
}

/**
 * 月度账单 job（scheduler 无 Profile 运行）：遍历有账本数据的 Profile 逐个发布
 * 上一个自然月汇总（架构 §9「公共任务按 Profile 物化」）。通知失败记录日志继续，
 * 不阻断后续 Profile。
 */
export async function runMonthlyReports(options: { at?: Date; month?: string } = {}): Promise<string[]> {
  const at = options.at ?? new Date();
  const month = options.month ?? previousMonthKey(at);
  const rows = getDatabase().prepare("SELECT DISTINCT profile_id FROM ledger_members").all() as Array<{ profile_id: string }>;
  const published: string[] = [];
  for (const row of rows) {
    const report = buildMonthlyReport(row.profile_id, month);
    if (!report.hasData) continue;
    try {
      await publishNotification(buildMonthlyReportNotification(report));
      published.push(row.profile_id);
    } catch (error) {
      console.error(`[bookkeeping] monthly report publish failed for ${row.profile_id}:`, (error as Error).message);
    }
  }
  return published;
}
