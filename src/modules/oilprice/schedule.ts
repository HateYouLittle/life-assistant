/**
 * 油价调价窗口计划：依据发改委"每 10 个工作日一调"机制和公开日历校准。
 * 国家发改委公布每轮正式调价结果；特殊情形下调价可能暂停或延迟。
 * 窗口当天 24:00 生效，Provider 的正式结果发布时间不固定。
 *
 * 静态表只到 2026 年（需根据公开日历和正式调价结果继续维护，PR welcome）；
 * 表外年份（2027 起）由 nextWindow 按"每 10 个工作日（周一至周五）"规则生成
 * 候选窗口——候选未剔除法定节假日顺延，均带 calibrated: false 标记，
 * 官方日历公布后请把对应年份硬编码进静态表并保持候选生成自动续接。
 */

/** 2026 年计划窗口（窗口日期，24:00 生效）——请按公开日历与正式结果校准 */
import { DateTime } from "luxon";

const BUSINESS_TIMEZONE = "Asia/Shanghai";
const CANDIDATE_STEP_WORKDAYS = 10;
const MAX_CANDIDATES = 2000;

export const ADJUSTMENT_WINDOWS_2026 = [
  "2026-01-06", "2026-01-20", "2026-02-03", "2026-02-24", "2026-03-09",
  "2026-03-23", "2026-04-07", "2026-04-21", "2026-05-08", "2026-05-21",
  "2026-06-04", "2026-06-18", "2026-07-03", "2026-07-17", "2026-07-31",
  "2026-08-14", "2026-08-28", "2026-09-11", "2026-09-24", "2026-10-15",
  "2026-10-29", "2026-11-12", "2026-11-26", "2026-12-10", "2026-12-24",
];

/**
 * 2027 年计划窗口——截至本实现日期未查到官方发布的 2027 调价日历
 * （国务院 2027 年节假日安排尚未公布，无法按"10 个工作日 + 节假日顺延"精确校准），
 * 故暂为空；nextWindow 会从上一静态窗口续推候选窗口（calibrated: false）。
 * 官方日历公布后请硬编码填入此处，候选生成会自动从最后一个静态窗口续接。
 */
export const ADJUSTMENT_WINDOWS_2027: string[] = [];

/** 静态校准表（按年份拼接）；候选生成以其最后一个窗口为锚点续推 */
const STATIC_WINDOWS: string[] = [
  ...ADJUSTMENT_WINDOWS_2026,
  ...ADJUSTMENT_WINDOWS_2027,
];

export interface AdjustmentWindow {
  date: string;          // 窗口日，当日 24:00 生效
  effectiveAt: string;   // 窗口日次日 00:00+08:00
  hoursUntil: number;    // 距生效小时数
  /** 仅表外候选窗口（按"每 10 个工作日"规则生成、未经官方日历校准）为 false；静态表窗口不设该字段 */
  calibrated?: boolean;
}

/** 从 from 起推进 count 个工作日（周一至周五），返回其日期（含当天在内不计入推进天数） */
function addWorkdays(from: DateTime, count: number): DateTime {
  let cursor = from;
  let remaining = count;
  while (remaining > 0) {
    cursor = cursor.plus({ days: 1 });
    // luxon weekday: 1=周一 … 5=周五
    if (cursor.weekday <= 5) remaining -= 1;
  }
  return cursor;
}

/**
 * 按"每 10 个工作日一调"规则从锚点窗口（含）续推 count 个候选窗口日期。
 * 规则不含法定节假日剔除，生成结果均为未校准候选，供测试与表外年份使用。
 */
export function candidateWindowDatesFrom(anchorDate: string, count: number): string[] {
  const anchor: DateTime = DateTime.fromISO(anchorDate, { zone: BUSINESS_TIMEZONE }) as DateTime;
  if (!anchor.isValid) throw new Error(`invalid candidate anchor date: ${anchorDate}`);
  const dates: string[] = [];
  let cursor: DateTime = anchor;
  for (let i = 0; i < count; i += 1) {
    cursor = addWorkdays(cursor, CANDIDATE_STEP_WORKDAYS);
    const iso = cursor.toISODate();
    if (!iso) throw new Error(`invalid candidate window date from anchor ${anchorDate}`);
    dates.push(iso);
  }
  return dates;
}

function windowFor(date: string, effective: DateTime, now: Date): AdjustmentWindow {
  const effectiveAt = effective.toISO({ suppressMilliseconds: true });
  if (!effectiveAt) throw new Error(`invalid oil-price adjustment window: ${date}`);
  return {
    date,
    effectiveAt,
    // 保留精确值供逻辑阈值（如 hoursUntil < 40）使用；展示层再取整
    hoursUntil: (effective.toMillis() - now.getTime()) / 3600_000,
  };
}

/** 找到下一个调价窗口；静态表耗尽后返回按规则生成的候选窗口（calibrated: false）而非 null */
export function nextWindow(now = new Date()): AdjustmentWindow | null {
  for (const date of STATIC_WINDOWS) {
    const effective = DateTime.fromISO(date, { zone: BUSINESS_TIMEZONE }).plus({ days: 1 }).startOf("day");
    if (effective.toMillis() > now.getTime()) return windowFor(date, effective, now);
  }
  // 静态表已耗尽：从最后一个静态窗口按"每 10 个工作日"规则续推候选窗口（未校准）
  const lastStatic = STATIC_WINDOWS[STATIC_WINDOWS.length - 1];
  const anchor: DateTime = DateTime.fromISO(lastStatic, { zone: BUSINESS_TIMEZONE }) as DateTime;
  if (!anchor.isValid) throw new Error(`invalid last static adjustment window: ${lastStatic}`);
  let cursor: DateTime = anchor;
  for (let i = 0; i < MAX_CANDIDATES; i += 1) {
    cursor = addWorkdays(cursor, CANDIDATE_STEP_WORKDAYS);
    const date = cursor.toISODate();
    if (!date) throw new Error(`invalid candidate window date from anchor ${lastStatic}`);
    const effective: DateTime = cursor.plus({ days: 1 }).startOf("day");
    if (effective.toMillis() > now.getTime()) {
      return { ...windowFor(date, effective, now), calibrated: false };
    }
  }
  return null;
}

/**
 * 计算某个窗口日与静态表/候选窗口最近窗口的偏差天数。
 * Provider 的 windowDate 是"最近一次已生效的窗口"，因此必须与表中最近的窗口对比
 * （而不是下一个窗口），否则正常数据每天都会误告警。
 * 表外年份叠加候选窗口参与比较，避免 2027 年起对接近候选窗口的正常数据每日误告警
 * （候选未剔除节假日，与真实窗口仍有偏差会照常告警，属预期）。
 */
export function nearestWindowDeviationDays(date: string): number | null {
  const parsed = DateTime.fromISO(date, { zone: BUSINESS_TIMEZONE });
  if (!parsed.isValid) return null;
  let minDays: number | null = null;
  const consider = (candidate: string): void => {
    const deviation = Math.abs(parsed.diff(DateTime.fromISO(candidate, { zone: BUSINESS_TIMEZONE }), "days").days);
    // 表内条目损坏导致 NaN 时跳过，避免告警被静默禁用
    if (!Number.isFinite(deviation)) return;
    if (minDays === null || deviation < minDays) minDays = deviation;
  };
  for (const entry of STATIC_WINDOWS) consider(entry);
  // 候选窗口日期单调递增；目标日期已落后候选 15 天以上时偏差只会更大，无需继续
  let cursor: DateTime = DateTime.fromISO(STATIC_WINDOWS[STATIC_WINDOWS.length - 1], { zone: BUSINESS_TIMEZONE }) as DateTime;
  let generated = 0;
  while (generated < MAX_CANDIDATES && cursor.toMillis() - parsed.toMillis() <= 15 * 86400_000) {
    cursor = addWorkdays(cursor, CANDIDATE_STEP_WORKDAYS);
    const candidateDate = cursor.toISODate();
    if (candidateDate) consider(candidateDate);
    generated += 1;
  }
  return minDays;
}