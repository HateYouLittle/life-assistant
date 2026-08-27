import { DateTime } from "luxon";
import {
  registerNotificationBlocks,
  type EnvelopeFor,
  type NotificationEnvelope,
  type RenderBlock,
} from "../../core/notification.js";

// 载荷与渲染归本模块所有；core 只保留信封骨架与投影管道。

export interface OilPriceAdvanceNoticePayload {
  windowDate: string;
  effectiveAt: string;
  timezone: string;
  tip: string;
}

export interface OilPriceOfficialResultPayload {
  province: string;
  windowDate: string;
  effectiveAt: string;
  timezone: string;
  unit: "元/升";
  fuels: Record<"p92" | "p95" | "p0", { current: string; change: string }>;
  source: string;
}

export type AdvanceNoticeEnvelope = EnvelopeFor<"oilprice.advance_notice", OilPriceAdvanceNoticePayload>;
export type OfficialResultEnvelope = EnvelopeFor<"oilprice.official_result", OilPriceOfficialResultPayload>;

const TIMEZONE = "Asia/Shanghai";

function displayDate(value: string): string {
  return DateTime.fromISO(value, { zone: TIMEZONE }).toFormat("yyyy年M月d日");
}

export function advanceNoticeNotification(input: {
  windowDate: string;
  effectiveAt: string;
  generatedAt: string;
}): AdvanceNoticeEnvelope {
  return {
    kind: "oilprice.advance_notice",
    identity: `advance:${input.windowDate}`,
    source: "oilprice",
    scope: { type: "global" },
    headline: `下一轮油价调整窗口：${displayDate(input.windowDate)}`,
    generatedAt: input.generatedAt,
    payload: {
      windowDate: input.windowDate,
      effectiveAt: input.effectiveAt,
      timezone: TIMEZONE,
      tip: "如近期需要加油，请留意正式调价结果。",
    },
  };
}

export interface OfficialResultInput {
  province: string;
  windowDate: string;
  effectiveAt: string;
  generatedAt: string;
  provider: string;
  source: string;
  unit: "元/升";
  fuels: Record<"p92" | "p95" | "p0", { current: string; change: string }>;
}

function changeDirection(change: string): -1 | 0 | 1 | undefined {
  if (!/^-?\d+(?:\.\d+)?$/.test(change)) return undefined;
  const amount = Number(change);
  if (!Number.isFinite(amount)) return undefined;
  return amount < 0 ? -1 : amount > 0 ? 1 : 0;
}

function officialResultHeadline(input: OfficialResultInput): string {
  const directions = Object.values(input.fuels).map((fuel) => changeDirection(fuel.change));
  if (directions.every((direction) => direction === 1)) {
    return `${input.province}油价已上调，92号每升上涨${input.fuels.p92.change}元`;
  }
  if (directions.every((direction) => direction === -1)) {
    return `${input.province}油价已下调，92号每升下降${input.fuels.p92.change.slice(1)}元`;
  }
  return `${input.province}油价调整结果已发布`;
}

export function officialResultNotification(
  input: OfficialResultInput,
): OfficialResultEnvelope {
  return {
    kind: "oilprice.official_result",
    identity: `result:${input.province}:${input.windowDate}`,
    source: "oilprice",
    scope: { type: "global" },
    headline: officialResultHeadline(input),
    generatedAt: input.generatedAt,
    provenance: { provider: input.provider },
    payload: {
      province: input.province,
      windowDate: input.windowDate,
      effectiveAt: input.effectiveAt,
      timezone: TIMEZONE,
      unit: input.unit,
      fuels: input.fuels,
      source: input.source,
    },
  };
}

// ---------------------------------------------------------------------------
// RenderBlock[] 构造器（自 core/notification.ts 下放，逻辑逐行保留）
// ---------------------------------------------------------------------------

function formatBusinessDate(value: string): string {
  return DateTime.fromISO(value, { zone: "Asia/Shanghai" }).toFormat("yyyy年M月d日");
}

function oilPriceAdvanceBlocks(payload: OilPriceAdvanceNoticePayload): RenderBlock[] {
  return [
    { type: "label", label: "调整时间", value: `${formatBusinessDate(payload.windowDate)} 24:00（北京时间）` },
    { type: "label", label: "正式涨跌", value: "尚未发布" },
    { type: "label", label: "提示", value: payload.tip },
  ];
}

function renderChange(value: string): string {
  if (value.startsWith("-")) return `每升下降${value.slice(1)}元`;
  if (/^0(?:\.0+)?$/.test(value)) return "每升价格不变";
  return `每升上涨${value}元`;
}

function oilPriceResultBlocks(notification: NotificationEnvelope): RenderBlock[] {
  const payload = notification.payload as OilPriceOfficialResultPayload;
  const { provenance } = notification;
  const effectiveAt = `${formatBusinessDate(payload.windowDate)} 24:00`;
  const blocks: RenderBlock[] = ([
    ["92号汽油", payload.fuels.p92],
    ["95号汽油", payload.fuels.p95],
    ["0号柴油", payload.fuels.p0],
  ] as const).map(([label, fuel]) => ({
    type: "label",
    label,
    value: `${fuel.current}${payload.unit}，${renderChange(fuel.change)}`,
  } as const));
  blocks.push({ type: "label", label: "生效时间", value: `${effectiveAt}（北京时间）` });
  blocks.push({ type: "label", label: "地区", value: payload.province });
  const provider = provenance?.provider?.trim();
  const sourceIncludesProvider = provider
    ? payload.source.toLocaleLowerCase().includes(provider.toLocaleLowerCase())
    : false;
  blocks.push({
    type: "label",
    label: "来源",
    value: `${payload.source}${provider && !sourceIncludesProvider ? `（${provider}）` : ""}`,
  });
  return blocks;
}

registerNotificationBlocks("oilprice.advance_notice", (n) => oilPriceAdvanceBlocks(n.payload as OilPriceAdvanceNoticePayload));
registerNotificationBlocks("oilprice.official_result", oilPriceResultBlocks);
