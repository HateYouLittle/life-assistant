import { DateTime } from "luxon";
import type { NotificationEnvelope } from "../../core/notification.js";

const TIMEZONE = "Asia/Shanghai";

function displayDate(value: string): string {
  return DateTime.fromISO(value, { zone: TIMEZONE }).toFormat("yyyy年M月d日");
}

export function advanceNoticeNotification(input: {
  windowDate: string;
  effectiveAt: string;
  generatedAt: string;
}): Extract<NotificationEnvelope, { kind: "oilprice.advance_notice" }> {
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
): Extract<NotificationEnvelope, { kind: "oilprice.official_result" }> {
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
