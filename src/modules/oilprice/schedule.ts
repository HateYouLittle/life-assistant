/**
 * 油价调价窗口推算：发改委"每 10 个工作日一调"机制。
 * 内置年度已知窗口表（每年初发改委公布），窗口当天 24:00 生效，
 * 通常前一天 17:00-18:00 发布公告。算法免费且最可靠。
 *
 * 每年初需按发改委公告更新下表（PR welcome）。
 */

/** 2026 年调价窗口（窗口日期，24:00 生效）——请按发改委公告校准 */
const WINDOWS_2026 = [
  "2026-01-02", "2026-01-16", "2026-02-06", "2026-02-20", "2026-03-05",
  "2026-03-19", "2026-04-02", "2026-04-17", "2026-05-06", "2026-05-20",
  "2026-06-03", "2026-06-17", "2026-07-01", "2026-07-15", "2026-07-29",
  "2026-08-12", "2026-08-26", "2026-09-09", "2026-09-23", "2026-10-14",
  "2026-10-28", "2026-11-11", "2026-11-25", "2026-12-09", "2026-12-23",
];

export interface AdjustmentWindow {
  date: string;          // 生效日（24:00）
  announceAt: string;    // 预计公告时间（前一日 17:00）
  hoursUntil: number;    // 距生效小时数
}

/** 找到下一个调价窗口 */
export function nextWindow(now = new Date()): AdjustmentWindow | null {
  for (const d of WINDOWS_2026) {
    const effective = new Date(`${d}T24:00:00+08:00`);
    if (effective.getTime() > now.getTime()) {
      const dayBefore = new Date(effective.getTime() - 24 * 3600 * 1000);
      return {
        date: d,
        announceAt: `${dayBefore.toISOString().slice(0, 10)} 17:00`,
        hoursUntil: (effective.getTime() - now.getTime()) / 3600_000,
      };
    }
  }
  return null;
}
