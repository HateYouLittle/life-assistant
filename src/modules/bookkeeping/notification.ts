import { DateTime } from "luxon";
import {
  registerNotificationBlocks,
  type EnvelopeFor,
  type RenderBlock,
} from "../../core/notification.js";
import { config } from "../../config.js";
import type { LedgerEntry, MonthlyReportData } from "./types.js";

// ---------------------------------------------------------------------------
// bookkeeping.shared_entry：共享账本成员动态（记账/修改/删除时通知除记录人外的成员）。
// identity 必须含 action 与 entry.updatedAt，防止 dedupeKey(source:identity)
// 吞掉同一流水的后续修改。
// ---------------------------------------------------------------------------

export type SharedEntryAction = "add" | "update" | "delete";

export interface SharedEntryPayload {
  ledgerId: string;
  ledgerName: string;
  entryId: string;
  action: SharedEntryAction;
  entryType: "expense" | "income" | "transfer";
  amountCents: number;
  category?: string;
  note?: string;
  actorProfileId: string;
  occurredAt: string;
  generatedAt: string;
  /** 涉及的账户：expense/income 为 accountId，transfer 含两端（L14）。 */
  accountId?: string;
  toAccountId?: string;
  /** 账户友好名（service 侧从 ledger_accounts.name 解析，2026-08-28）；缺省回落 UUID。 */
  accountName?: string;
  toAccountName?: string;
  /** 账户所属共享账本（个人账户缺省）；跨账本转账时标识对端账户/账本（M1）。 */
  accountLedgerId?: string;
  toAccountLedgerId?: string;
  /** 账户所属共享账本的友好名（service 侧从 ledgers.name 解析，2026-08-28）；缺省回落 ledgerId。 */
  accountLedgerName?: string;
  toAccountLedgerName?: string;
  /** update 留痕：accountId/toAccountId 变更前的旧值与原归属账本（M2）。 */
  previousAccountId?: string;
  previousToAccountId?: string;
  previousLedgerId?: string;
}

export type SharedEntryEnvelope = EnvelopeFor<"bookkeeping.shared_entry", SharedEntryPayload>;

export interface SharedEntryNotificationInput {
  /** 收件成员（除记录人外的每个成员各一条 profile scope 信封） */
  profileId: string;
  ledgerId: string;
  ledgerName: string;
  entry: Pick<LedgerEntry, "id" | "type" | "amountCents" | "category" | "note" | "occurredAt" | "updatedAt" | "ledgerId">;
  action: SharedEntryAction;
  actorProfileId: string;
  /** 端点账户及其所属共享账本（service 侧解析，M1/L14）。含账户名与账本名用于通知友好显示（2026-08-28）。 */
  accounts?: {
    accountId?: string;
    toAccountId?: string;
    accountName?: string;
    toAccountName?: string;
    accountLedgerId?: string;
    toAccountLedgerId?: string;
    accountLedgerName?: string;
    toAccountLedgerName?: string;
  };
  /** update 留痕：变更前的账户与归属账本（M2）。 */
  previous?: {
    accountId?: string;
    toAccountId?: string;
    ledgerId?: string;
  };
}

const ENTRY_TYPE_LABELS = { expense: "支出", income: "收入", transfer: "转账" } as const;
const ACTION_VERBS = { add: "记了一笔", update: "修改了一笔", delete: "删除了一笔" } as const;

export function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function buildSharedEntryNotification(input: SharedEntryNotificationInput): SharedEntryEnvelope {
  const { profileId, ledgerId, ledgerName, entry, action, actorProfileId } = input;
  const accounts = input.accounts;
  const previous = input.previous;
  const categorySuffix = entry.category ? `（${entry.category}）` : "";
  const headline = `${ledgerName} · ${actorLabel(actorProfileId)} ${ACTION_VERBS[action]}${ENTRY_TYPE_LABELS[entry.type]} ¥${formatYuan(entry.amountCents)}${categorySuffix}`;
  // 留痕仅在值确实变化时输出：old ≠ new 才带 previous 字段（M2）。
  const accountChanged = previous?.accountId !== undefined && previous.accountId !== accounts?.accountId;
  const toAccountChanged = previous?.toAccountId !== undefined && previous.toAccountId !== accounts?.toAccountId;
  const ledgerMoved = previous?.ledgerId !== undefined && previous.ledgerId !== entry.ledgerId;
  return {
    kind: "bookkeeping.shared_entry",
    identity: `${ledgerId}:${entry.id}:${action}:${entry.updatedAt}`,
    source: "bookkeeping",
    scope: { type: "profile", profileId },
    headline,
    generatedAt: entry.updatedAt,
    payload: {
      ledgerId,
      ledgerName,
      entryId: entry.id,
      action,
      entryType: entry.type,
      amountCents: entry.amountCents,
      ...(entry.category ? { category: entry.category } : {}),
      ...(entry.note ? { note: entry.note } : {}),
      actorProfileId,
      occurredAt: entry.occurredAt,
      generatedAt: entry.updatedAt,
      ...(accounts?.accountId !== undefined ? { accountId: accounts.accountId } : {}),
      ...(accounts?.toAccountId !== undefined ? { toAccountId: accounts.toAccountId } : {}),
      ...(accounts?.accountName !== undefined ? { accountName: accounts.accountName } : {}),
      ...(accounts?.toAccountName !== undefined ? { toAccountName: accounts.toAccountName } : {}),
      ...(accounts?.accountLedgerId !== undefined ? { accountLedgerId: accounts.accountLedgerId } : {}),
      ...(accounts?.toAccountLedgerId !== undefined ? { toAccountLedgerId: accounts.toAccountLedgerId } : {}),
      ...(accounts?.accountLedgerName !== undefined ? { accountLedgerName: accounts.accountLedgerName } : {}),
      ...(accounts?.toAccountLedgerName !== undefined ? { toAccountLedgerName: accounts.toAccountLedgerName } : {}),
      ...(accountChanged ? { previousAccountId: previous.accountId } : {}),
      ...(toAccountChanged ? { previousToAccountId: previous.toAccountId } : {}),
      ...(ledgerMoved ? { previousLedgerId: previous.ledgerId } : {}),
    },
  };
}

/** 渲染账户行：优先账户友好名，缺省回落 UUID；共享账户附带所属账本（优先账本名，回落 id，M1）。 */
function accountLabel(accountName: string | undefined, accountId: string, ledgerName: string | undefined, ledgerId: string | undefined): string {
  const name = accountName ?? accountId;
  if (!ledgerId) return name;
  const ledgerLabel = ledgerName ?? ledgerId;
  return `${name}（账本 ${ledgerLabel}）`;
}

/** 渲染记录人：优先 PROFILE_DISPLAY_NAMES 映射的友好名，缺省回落 profile id。 */
function actorLabel(actorProfileId: string): string {
  return config.profileDisplayNames[actorProfileId] ?? actorProfileId;
}

function sharedEntryBlocks(rawPayload: unknown): RenderBlock[] {
  const payload = rawPayload as SharedEntryPayload;
  const localTime = DateTime.fromISO(payload.occurredAt, { setZone: true })
    .setZone(config.timezone)
    .toFormat("yyyy-LL-dd HH:mm");
  const blocks: RenderBlock[] = [
    { type: "label", label: "账本", value: payload.ledgerName },
    { type: "label", label: "类型", value: ENTRY_TYPE_LABELS[payload.entryType] },
    { type: "label", label: "金额", value: `¥${formatYuan(payload.amountCents)}` },
  ];
  if (payload.entryType === "transfer") {
    if (payload.accountId) blocks.push({ type: "label", label: "转出账户", value: accountLabel(payload.accountName, payload.accountId, payload.accountLedgerName, payload.accountLedgerId) });
    if (payload.toAccountId) blocks.push({ type: "label", label: "转入账户", value: accountLabel(payload.toAccountName, payload.toAccountId, payload.toAccountLedgerName, payload.toAccountLedgerId) });
  } else if (payload.accountId) {
    blocks.push({ type: "label", label: "账户", value: accountLabel(payload.accountName, payload.accountId, payload.accountLedgerName, payload.accountLedgerId) });
  }
  if (payload.previousAccountId) blocks.push({ type: "label", label: "原账户", value: payload.previousAccountId });
  if (payload.previousToAccountId) blocks.push({ type: "label", label: "原转入账户", value: payload.previousToAccountId });
  if (payload.previousLedgerId) blocks.push({ type: "label", label: "原账本", value: payload.previousLedgerId });
  if (payload.category) blocks.push({ type: "label", label: "分类", value: payload.category });
  blocks.push({ type: "label", label: "记录人", value: actorLabel(payload.actorProfileId) });
  blocks.push({ type: "label", label: "时间", value: localTime });
  if (payload.note) blocks.push({ type: "label", label: "备注", value: payload.note });
  return blocks;
}

// ---------------------------------------------------------------------------
// bookkeeping.monthly_report：月度账单（每月 1 号由 scheduler 推送上月汇总）。
// identity = `${profileId}:${month}`，天然幂等，job 重跑不重复推。
// ---------------------------------------------------------------------------

export interface MonthlyReportPayload {
  profileId: string;
  month: string;
  personal: {
    incomeCents: number;
    expenseCents: number;
    netCents: number;
    topCategories: Array<{ category: string; amountCents: number }>;
  };
  shared: Array<{
    ledgerId: string;
    ledgerName: string;
    incomeCents: number;
    expenseCents: number;
    balanceCents: number;
  }>;
  generatedAt: string;
}

export type MonthlyReportEnvelope = EnvelopeFor<"bookkeeping.monthly_report", MonthlyReportPayload>;

export function buildMonthlyReportNotification(report: MonthlyReportData): MonthlyReportEnvelope {
  const { personal, shared } = report;
  const netWord = personal.netCents >= 0 ? "结余" : "超支";
  const headline = `${report.month} 月度账单 · 收入 ¥${formatYuan(personal.incomeCents)} · 支出 ¥${formatYuan(personal.expenseCents)} · ${netWord} ¥${formatYuan(Math.abs(personal.netCents))}`;
  const generatedAt = new Date().toISOString();
  return {
    kind: "bookkeeping.monthly_report",
    identity: `${report.profileId}:${report.month}`,
    source: "bookkeeping",
    scope: { type: "profile", profileId: report.profileId },
    headline,
    generatedAt,
    payload: {
      profileId: report.profileId,
      month: report.month,
      personal: {
        incomeCents: personal.incomeCents,
        expenseCents: personal.expenseCents,
        netCents: personal.netCents,
        topCategories: personal.topCategories,
      },
      shared: shared.map((part) => ({ ...part })),
      generatedAt,
    },
  };
}

function monthlyReportBlocks(rawPayload: unknown): RenderBlock[] {
  const payload = rawPayload as MonthlyReportPayload;
  const blocks: RenderBlock[] = [
    { type: "section", title: "个人账本" },
    { type: "label", label: "收入", value: `¥${formatYuan(payload.personal.incomeCents)}` },
    { type: "label", label: "支出", value: `¥${formatYuan(payload.personal.expenseCents)}` },
    { type: "label", label: "结余", value: `¥${formatYuan(payload.personal.netCents)}` },
  ];
  if (payload.personal.topCategories.length > 0) {
    blocks.push({
      type: "label",
      label: "支出分类",
      value: payload.personal.topCategories
        .map((item) => `${item.category} ¥${formatYuan(item.amountCents)}`)
        .join("、"),
    });
  }
  for (const part of payload.shared) {
    blocks.push({ type: "section", title: `共享账本 · ${part.ledgerName}` });
    blocks.push({ type: "label", label: "收入", value: `¥${formatYuan(part.incomeCents)}` });
    blocks.push({ type: "label", label: "支出", value: `¥${formatYuan(part.expenseCents)}` });
    blocks.push({ type: "label", label: "当前余额", value: `¥${formatYuan(part.balanceCents)}` });
  }
  return blocks;
}

registerNotificationBlocks("bookkeeping.shared_entry", (n) => sharedEntryBlocks(n.payload));
registerNotificationBlocks("bookkeeping.monthly_report", (n) => monthlyReportBlocks(n.payload));
