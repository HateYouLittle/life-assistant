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
}

export type SharedEntryEnvelope = EnvelopeFor<"bookkeeping.shared_entry", SharedEntryPayload>;

export interface SharedEntryNotificationInput {
  /** 收件成员（除记录人外的每个成员各一条 profile scope 信封） */
  profileId: string;
  ledgerId: string;
  ledgerName: string;
  entry: Pick<LedgerEntry, "id" | "type" | "amountCents" | "category" | "note" | "occurredAt" | "updatedAt">;
  action: SharedEntryAction;
  actorProfileId: string;
}

const ENTRY_TYPE_LABELS = { expense: "支出", income: "收入", transfer: "转账" } as const;
const ACTION_VERBS = { add: "记了一笔", update: "修改了一笔", delete: "删除了一笔" } as const;

export function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function buildSharedEntryNotification(input: SharedEntryNotificationInput): SharedEntryEnvelope {
  const { profileId, ledgerId, ledgerName, entry, action, actorProfileId } = input;
  const categorySuffix = entry.category ? `（${entry.category}）` : "";
  const headline = `${ledgerName} · ${actorProfileId} ${ACTION_VERBS[action]}${ENTRY_TYPE_LABELS[entry.type]} ¥${formatYuan(entry.amountCents)}${categorySuffix}`;
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
    },
  };
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
  if (payload.category) blocks.push({ type: "label", label: "分类", value: payload.category });
  blocks.push({ type: "label", label: "记录人", value: payload.actorProfileId });
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
  return {
    kind: "bookkeeping.monthly_report",
    identity: `${report.profileId}:${report.month}`,
    source: "bookkeeping",
    scope: { type: "profile", profileId: report.profileId },
    headline,
    generatedAt: new Date().toISOString(),
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
      generatedAt: new Date().toISOString(),
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
