import { z } from "zod";

// ---------------------------------------------------------------------------
// 实体类型（与 ledger* 表列一一对应；时间均为 UTC ISO 字符串，金额一律为分）
// ---------------------------------------------------------------------------

export type LedgerType = "personal" | "shared";
export type LedgerRole = "owner" | "member";
export type AccountKind = "personal" | "shared";
export type EntryType = "expense" | "income" | "transfer";

export const ACCOUNT_TYPES = ["cash", "bank", "alipay", "wechat", "other"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface Ledger {
  id: string;
  type: LedgerType;
  name: string;
  ownerProfileId: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerMember {
  ledgerId: string;
  profileId: string;
  role: LedgerRole;
  joinedAt: string;
}

export interface LedgerAccount {
  id: string;
  kind: AccountKind;
  /** kind=personal 必填；shared 为 undefined */
  ownerProfileId?: string;
  /** kind=shared 必填；personal 为 undefined */
  ledgerId?: string;
  name: string;
  type: AccountType;
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 账户 + 由流水派生的实时余额（不落库）。 */
export interface AccountView extends LedgerAccount {
  balanceCents: number;
}

export interface LedgerEntry {
  ledgerId: string;
  id: string;
  /** 记录人 */
  profileId: string;
  type: EntryType;
  amountCents: number;
  /** transfer 为 undefined；expense/income 必填 */
  category?: string;
  /** expense/income 的账户；transfer 的源账户 */
  accountId?: string;
  /** 仅 transfer */
  toAccountId?: string;
  occurredAt: string;
  note?: string;
  /** 乐观锁 */
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 视图类型（service 返回给工具层的聚合形状）
// ---------------------------------------------------------------------------

export interface LedgerView {
  id: string;
  type: LedgerType;
  name: string;
  ownerProfileId: string;
  /** 当前调用者在该账本中的角色 */
  role: LedgerRole;
  memberCount: number;
  accountCount: number;
  totalBalanceCents: number;
  createdAt: string;
}

export interface CategoryTotal {
  category: string;
  amountCents: number;
}

export interface AccountBalanceView {
  id: string;
  name: string;
  type: AccountType;
  kind: AccountKind;
  archived: boolean;
  balanceCents: number;
}

export interface SummaryView {
  ledgerId: string;
  ledgerName: string;
  /** yyyy-LL（按 config.timezone 的自然月） */
  month: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  entryCount: number;
  expenseByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  /** 账户余额为全期实时余额，不随 month 截止 */
  accounts: AccountBalanceView[];
}

export interface MonthlyReportSharedPart {
  ledgerId: string;
  ledgerName: string;
  incomeCents: number;
  expenseCents: number;
  /** 该账本共享账户的当前总余额 */
  balanceCents: number;
}

export interface MonthlyReportData {
  profileId: string;
  /** yyyy-LL（上一个自然月，config.timezone） */
  month: string;
  /** 上月（个人或任一共享账本）无任何流水时为 false，job 跳过不推送 */
  hasData: boolean;
  personal: {
    incomeCents: number;
    expenseCents: number;
    netCents: number;
    /** 支出分类 Top5 */
    topCategories: CategoryTotal[];
  };
  shared: MonthlyReportSharedPart[];
}

// ---------------------------------------------------------------------------
// 输入类型
// ---------------------------------------------------------------------------

export interface AccountCreateInput {
  name: string;
  type?: AccountType;
  /** 提供时在该共享账本下建共享账户（仅 owner）；缺省建个人账户 */
  ledgerId?: string;
  /** 元，> 0；提供时自动补一条「期初余额」流水 */
  initialBalance?: number;
}

export interface AccountUpdateInput {
  name?: string;
  type?: AccountType;
  archived?: boolean;
}

export interface EntryAddInput {
  type: EntryType;
  /** 元，> 0，最多两位小数 */
  amount: number;
  /** expense/income 必填；transfer 禁止 */
  category?: string;
  accountId?: string;
  /** 仅 transfer；必须 ≠ accountId */
  toAccountId?: string;
  /** ISO 时间；缺省当前时间 */
  occurredAt?: string;
  note?: string;
}

export interface EntryUpdateInput {
  /** 乐观锁：必须等于当前 version */
  version: number;
  amount?: number;
  category?: string;
  accountId?: string;
  toAccountId?: string;
  occurredAt?: string;
  note?: string;
}

export interface EntryListOptions {
  type?: EntryType;
  category?: string;
  /** ISO 时间（含）下界，按 occurred_at */
  from?: string;
  /** ISO 时间（含）上界 */
  to?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// 共享 zod schema 片段：工具层与 service 共用同一套口径（金额单位是元）
// ---------------------------------------------------------------------------

export const accountTypeSchema = z.enum(ACCOUNT_TYPES);

export const entryTypeSchema = z.enum(["expense", "income", "transfer"]);

/**
 * 金额上限（元）：9e12 元 = 9e14 分，远低于 Number.MAX_SAFE_INTEGER（≈9.0072e15），
 * 保证转分后整数值精度无损；超过该上限的金额在存储层无法可靠表示，直接拒绝。
 */
export const MAX_AMOUNT_YUAN = 9e12;

/** 元：> 0、≤ 9e12 且最多两位小数（存储层转分，拒绝三位以上小数与浮点噪声）。 */
export const amountYuanSchema = z
  .number()
  .positive("amount must be greater than 0")
  .max(MAX_AMOUNT_YUAN, "amount must be at most 9000000000000 yuan")
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: "amount supports at most 2 decimal places",
  });

/** 自然月：yyyy-LL（如 2026-08）。 */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be yyyy-LL");
