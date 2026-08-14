/**
 * 油价调价窗口计划：依据发改委"每 10 个工作日一调"机制和公开日历校准。
 * 国家发改委公布每轮正式调价结果；特殊情形下调价可能暂停或延迟。
 * 窗口当天 24:00 生效，Provider 的正式结果发布时间不固定。
 *
 * 需根据公开日历和正式调价结果维护下表（PR welcome）。
 */

/** 2026 年计划窗口（窗口日期，24:00 生效）——请按公开日历与正式结果校准 */
import { DateTime } from "luxon";

const BUSINESS_TIMEZONE = "Asia/Shanghai";

export const ADJUSTMENT_WINDOWS_2026 = [
  "2026-01-06", "2026-01-20", "2026-02-03", "2026-02-24", "2026-03-09",
  "2026-03-23", "2026-04-07", "2026-04-21", "2026-05-08", "2026-05-21",
  "2026-06-04", "2026-06-18", "2026-07-03", "2026-07-17", "2026-07-31",
  "2026-08-14", "2026-08-28", "2026-09-11", "2026-09-24", "2026-10-15",
  "2026-10-29", "2026-11-12", "2026-11-26", "2026-12-10", "2026-12-24",
];

export interface AdjustmentWindow {
  date: string;          // 窗口日，当日 24:00 生效
  effectiveAt: string;   // 窗口日次日 00:00+08:00
  hoursUntil: number;    // 距生效小时数
}

/** 找到下一个调价窗口 */
export function nextWindow(now = new Date()): AdjustmentWindow | null {
  for (const date of ADJUSTMENT_WINDOWS_2026) {
    const effective = DateTime.fromISO(date, { zone: BUSINESS_TIMEZONE }).plus({ days: 1 }).startOf("day");
    if (effective.toMillis() > now.getTime()) {
      const effectiveAt = effective.toISO({ suppressMilliseconds: true });
      if (!effectiveAt) throw new Error(`invalid oil-price adjustment window: ${date}`);
      return {
        date,
        effectiveAt,
        // 保留 1 位小数，避免浮点误差导致展示为 182.99999999999997
        hoursUntil: Math.round(((effective.toMillis() - now.getTime()) / 3600_000) * 10) / 10,
      };
    }
  }
  return null;
}

/**
 * 计算某个窗口日与静态表最近窗口的偏差天数。
 * Provider 的 windowDate 是"最近一次已生效的窗口"，因此必须与表中的最近窗口对比
 * （而不是下一个窗口），否则正常数据每天都会误告警。
 */
export function nearestWindowDeviationDays(date: string): number | null {
  const parsed = DateTime.fromISO(date, { zone: BUSINESS_TIMEZONE });
  if (!parsed.isValid) return null;
  let minDays: number | null = null;
  for (const entry of ADJUSTMENT_WINDOWS_2026) {
    const deviation = Math.abs(parsed.diff(DateTime.fromISO(entry, { zone: BUSINESS_TIMEZONE }), "days").days);
    if (minDays === null || deviation < minDays) minDays = deviation;
  }
  return minDays;
}
