import crypto from "node:crypto";
import rrulePkg from "rrule";
import { DateTime } from "luxon";
import { Lunar, LunarYear } from "lunar-javascript";
import { getDatabase } from "../../core/database.js";
import { requireProfileContext, type ProfileContext } from "../../core/profile.js";
import { config } from "../../config.js";
import type {
  CalendarType,
  Frequency,
  LeapMonthPolicy,
  Priority,
  RecurrenceRule,
  ReminderInput,
  ReminderTarget,
  ScheduleInput,
  ScheduleItem,
  ScheduleListOptions,
  ScheduleStatus,
  ScheduleType,
} from "./types.js";

const { RRule } = rrulePkg as unknown as { RRule: any };
const DEFAULT_ZONE = config.timezone;
const DEFAULT_TIME = "09:00";
const VALID_FREQUENCIES = ["once", "daily", "weekly", "monthly", "yearly"];
const VALID_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
type ValidDateTime = DateTime<true>;

function context(value: ProfileContext | string): ProfileContext {
  const id = typeof value === "string" ? value : value.id;
  if (!VALID_PROFILE.test(id)) throw new Error("invalid Profile context");
  return requireProfileContext(id);
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

/** hydration 兜底：recurrence_json 形状/取值非法时回退安全默认，避免下游崩溃（P1-07）。 */
function sanitizeRecurrence(raw: unknown, calendar: CalendarType): RecurrenceRule {
  const fallback: RecurrenceRule = { frequency: "once", interval: 1, calendar };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.frequency !== "string" || !VALID_FREQUENCIES.includes(candidate.frequency as Frequency)) {
    return fallback;
  }
  const interval = candidate.interval;
  // 可选字段一律做类型/取值强制，非法即丢弃，杜绝损坏行再次进入 RRule/luxon 崩溃路径
  let until = typeof candidate.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.until)
    ? candidate.until
    : undefined;
  // 格式合法但日历非法（如 2099-02-30）会打挂 localDate/RRule，读取侧直接丢弃
  if (until !== undefined && !DateTime.fromISO(until, { zone: "utc" }).isValid) until = undefined;
  let count = Number.isInteger(candidate.count) && (candidate.count as number) >= 1
    ? candidate.count as number
    : undefined;
  // 存量行可能同时含 count 与 until（旧 schema 允许）：读取侧保留 count、丢弃 until，
  // 避免 update 时被互斥校验误伤（输入路径仍严格互斥）。
  if (count !== undefined && until !== undefined) until = undefined;
  const byMonthDay = Number.isInteger(candidate.byMonthDay)
    && (candidate.byMonthDay as number) >= 1
    && (candidate.byMonthDay as number) <= 31
    ? candidate.byMonthDay as number
    : undefined;
  const byWeekday = Array.isArray(candidate.byWeekday)
    ? candidate.byWeekday.filter((day): day is string =>
      typeof day === "string" && ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].includes(day))
    : undefined;
  const leapMonthPolicy = calendar === "lunar" && typeof candidate.leapMonthPolicy === "string"
    // N3/D1-A：both/prefer-leap 未实现，读取侧归一为 normal（与 solarForLunar 现行为一致），
    // 不保留一个不会正确执行的策略；非法取值同样回退 normal。
    ? (candidate.leapMonthPolicy === "leap" ? "leap" : "normal")
    : undefined;
  return {
    frequency: candidate.frequency as Frequency,
    interval: Number.isInteger(interval) && (interval as number) >= 1 ? (interval as number) : 1,
    ...(byWeekday && byWeekday.length > 0 ? { byWeekday } : {}),
    ...(byMonthDay !== undefined ? { byMonthDay } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(leapMonthPolicy !== undefined ? { leapMonthPolicy } : {}),
    calendar,
  };
}

/** hydration 兜底：reminders_json 非数组时给默认提醒；数组内逐条过滤非对象项并归一化（P1-07）。 */
function sanitizeReminders(raw: unknown): ReminderInput[] {
  if (!Array.isArray(raw)) return [{ minutesBefore: 0, id: "reminder-1", target: "occurrence" }];
  const seen = new Set<string>();
  return raw
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .map((entry, index) => {
      const rawId = typeof entry.id === "string" && entry.id ? entry.id : undefined;
      // 旧行可能含重复 id（输入路径已拒绝，此处兜底）：重复时回退为位置 id。
      // 自动生成的位置 id 同样占位去重集合（N1），避免与后续显式 id 撞车被静默折叠。
      let id = rawId ?? `reminder-${index + 1}`;
      if (seen.has(id)) {
        let suffix = index + 1;
        do {
          id = `reminder-${suffix}`;
          suffix += 1;
        } while (seen.has(id));
      }
      seen.add(id);
      return {
        id,
        minutesBefore: Number.isInteger(entry.minutesBefore)
          && (entry.minutesBefore as number) >= 0
          && (entry.minutesBefore as number) <= 60 * 24 * 365
          ? entry.minutesBefore as number
          : 0,
        target: entry.target === "deadline" ? "deadline" : "occurrence",
      };
    });
}

function assertDate(value: string | undefined, field: string): void {
  if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
}

function assertTime(value: string): void {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error("time must be HH:mm");
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) throw new Error("invalid time");
}

function localDate(date: string, time: string, timezone: string): ValidDateTime {
  const result = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  if (!result.isValid) throw new Error(`invalid date/time or timezone: ${result.invalidReason ?? timezone}`);
  return result as ValidDateTime;
}

function floatingDate(value: DateTime): Date {
  return new Date(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second, value.millisecond));
}

function fromFloating(value: Date, timezone: string): DateTime {
  const d = DateTime.fromJSDate(value, { zone: "utc" });
  return DateTime.fromObject({
    year: d.year,
    month: d.month,
    day: d.day,
    hour: d.hour,
    minute: d.minute,
    second: d.second,
    millisecond: d.millisecond,
  }, { zone: timezone });
}

function toUtc(value: DateTime): DateTime {
  return value.toUTC();
}

function fromUtc(iso: string): ValidDateTime {
  const result = DateTime.fromISO(iso, { zone: "utc" });
  if (!result.isValid) throw new Error(`invalid UTC timestamp: ${iso}`);
  return result as ValidDateTime;
}

function normalizeRecurrence(input: ScheduleInput, calendar: CalendarType, type: ScheduleType): RecurrenceRule {
  const raw = typeof input.recurrence === "string" ? { frequency: input.recurrence } : (input.recurrence ?? {});
  const frequency = (raw.frequency ?? (type === "birthday" || type === "anniversary" || calendar === "lunar" ? "yearly" : "once")) as Frequency;
  if (!["once", "daily", "weekly", "monthly", "yearly"].includes(frequency)) throw new Error("unsupported recurrence frequency");
  if (calendar === "lunar" && frequency !== "yearly") throw new Error("lunar schedules currently support yearly recurrence only");
  // P2-11：count 与 until 互斥，避免 RRule 语义歧义。
  if (raw.count !== undefined && raw.until !== undefined) {
    throw new Error("count and until are mutually exclusive");
  }
  const policy = input.leapMonthPolicy ?? (input.isLeapMonth ? "leap" : "normal");
  // N3/D1-A：both/prefer-leap 未实现，输入路径明确拒绝（MCP schema 已只开放 normal/leap，
  // 此处兜底直接调用 service 的路径）
  if (calendar === "lunar" && policy !== "normal" && policy !== "leap") {
    throw new Error("leapMonthPolicy must be 'normal' or 'leap'");
  }
  return {
    frequency,
    interval: Math.max(1, Number(raw.interval ?? 1)),
    byWeekday: raw.byWeekday,
    byMonthDay: raw.byMonthDay,
    until: raw.until,
    count: raw.count,
    calendar,
    leapMonthPolicy: calendar === "lunar" ? policy : undefined,
  };
}

function normalizeReminders(value: ReminderInput[] | undefined): ReminderInput[] {
  const reminders = value?.length ? value : [{ minutesBefore: 0 }];
  for (const reminder of reminders) {
    if (!Number.isInteger(reminder.minutesBefore) || reminder.minutesBefore < 0 || reminder.minutesBefore > 60 * 24 * 365) {
      throw new Error("reminder minutesBefore must be an integer between 0 and 525600");
    }
  }
  const normalized = reminders.map((reminder, index) => ({
    id: reminder.id ?? `reminder-${index + 1}`,
    minutesBefore: reminder.minutesBefore,
    target: reminder.target ?? "occurrence",
  }));
  // P2-10：提醒 id 必须唯一，dedupe 键依赖 id 区分同一 occurrence 的不同提醒。
  const ids = normalized.map((reminder) => reminder.id);
  if (new Set(ids).size !== ids.length) throw new Error("reminder ids must be unique");
  return normalized;
}

function normalizeDeadline(
  input: ScheduleInput,
  recurrence: RecurrenceRule,
  timezone: string,
  time: string,
): Pick<ScheduleInput, "deadlineAt" | "deadlineOffsetMinutes"> {
  const deadlineAt = input.clearDeadline ? undefined : input.deadlineAt;
  const deadlineOffsetMinutes = input.clearDeadline ? undefined : input.deadlineOffsetMinutes;
  if (deadlineOffsetMinutes !== undefined && (
    !Number.isInteger(deadlineOffsetMinutes)
    || deadlineOffsetMinutes < 0
    || deadlineOffsetMinutes > 525600
  )) {
    throw new Error("deadlineOffsetMinutes must be an integer between 0 and 525600");
  }
  if (recurrence.frequency === "once" && deadlineOffsetMinutes !== undefined) {
    throw new Error("once schedules require deadlineAt instead of deadlineOffsetMinutes");
  }
  if (recurrence.frequency !== "once" && deadlineAt !== undefined) {
    throw new Error("recurring schedules require deadlineOffsetMinutes instead of deadlineAt");
  }

  let normalizedDeadlineAt: string | undefined;
  if (deadlineAt !== undefined) {
    const parsed = DateTime.fromISO(deadlineAt, { zone: timezone });
    if (!parsed.isValid) {
      throw new Error("deadlineAt must be a valid ISO date-time in the schedule timezone");
    }
    if (!input.date) throw new Error("deadlineAt requires a dated occurrence");
    const occurrence = localDate(input.date, time, timezone);
    if (parsed < occurrence) throw new Error("deadline must not be earlier than occurrence");
    normalizedDeadlineAt = parsed.toUTC().toISO() ?? undefined;
  }
  if (input.reminders?.some((reminder) => reminder.target === "deadline")
    && normalizedDeadlineAt === undefined
    && deadlineOffsetMinutes === undefined) {
    throw new Error("deadline target requires a deadline");
  }
  return { deadlineAt: normalizedDeadlineAt, deadlineOffsetMinutes };
}

function normalizeInput(input: ScheduleInput): ScheduleInput & { type: ScheduleType; timezone: string; time: string; recurrence: RecurrenceRule; reminders: ReminderInput[]; allDay: boolean } {
  if (!input.title?.trim()) throw new Error("title is required");
  const type = input.type ?? "todo";
  const calendar = input.calendar ?? "solar";
  const timezone = input.timezone ?? DEFAULT_ZONE;
  const time = input.time ?? DEFAULT_TIME;
  assertTime(time);
  assertDate(input.date, "date");
  if (!DateTime.now().setZone(timezone).isValid) throw new Error(`invalid timezone: ${timezone}`);
  if (calendar === "solar" && !input.date) throw new Error("solar schedules require date");
  if (calendar === "lunar") {
    if (!Number.isInteger(input.lunarMonth) || !Number.isInteger(input.lunarDay) || input.lunarMonth! < 1 || input.lunarMonth! > 12 || input.lunarDay! < 1 || input.lunarDay! > 30) {
      throw new Error("lunar schedules require lunarMonth 1-12 and lunarDay 1-30");
    }
  }
  const recurrence = normalizeRecurrence(input, calendar, type);
  const reminders = normalizeReminders(input.reminders);
  const deadline = normalizeDeadline(input, recurrence, timezone, time);
  const { clearDeadline: _clearDeadline, ...persistentInput } = input;
  return {
    ...persistentInput,
    type,
    calendar,
    timezone,
    time,
    allDay: input.allDay ?? !input.time,
    recurrence,
    reminders,
    ...deadline,
    priority: input.priority ?? "normal",
    status: input.status ?? "active",
  };
}

function solarForLunar(year: number, month: number, day: number, policy: LeapMonthPolicy): string | null {
  const leapMonth = Number(LunarYear.fromYear(year).getLeapMonth());
  if (policy === "leap" && leapMonth !== month) return null;
  try {
    const lunarMonth = policy === "leap" ? -month : month;
    const solar = Lunar.fromYmd(year, lunarMonth, day).getSolar();
    return String(solar.toYmd());
  } catch {
    return null;
  }
}

function lunarEventAt(item: ScheduleItem, from: ValidDateTime, inclusive: boolean): ValidDateTime | null {
  const month = item.lunarMonth;
  const day = item.lunarDay;
  if (!month || !day) return null;
  const policy = item.recurrence.leapMonthPolicy ?? "normal";
  const localFrom = from.setZone(item.timezone);
  for (let year = localFrom.year - 1; year <= Math.min(localFrom.year + 80, 2100); year += 1) {
    const date = solarForLunar(year, month, day, policy);
    if (!date) continue;
    const event = localDate(date, item.time, item.timezone);
    const eventUtc = event.toUTC();
    if (eventUtc > from || (inclusive && eventUtc.equals(from))) return eventUtc as ValidDateTime;
  }
  return null;
}

function solarEventAt(item: ScheduleItem, from: ValidDateTime, inclusive: boolean): ValidDateTime | null {
  if (!item.date) return null;
  const base = localDate(item.date, item.time, item.timezone);
  if (item.recurrence.frequency === "once") return base.toUTC() as ValidDateTime;
  const freqMap: Record<string, number> = {
    daily: RRule.DAILY,
    weekly: RRule.WEEKLY,
    monthly: RRule.MONTHLY,
    yearly: RRule.YEARLY,
  };
  const baseLocal = base.setZone(item.timezone);
  const options: Record<string, unknown> = {
    freq: freqMap[item.recurrence.frequency],
    interval: item.recurrence.interval,
    dtstart: floatingDate(baseLocal),
  };
  if (item.recurrence.byMonthDay !== undefined) options.bymonthday = item.recurrence.byMonthDay;
  if (item.recurrence.byWeekday?.length) {
    const weekdays: Record<string, unknown> = { SU: RRule.SU, MO: RRule.MO, TU: RRule.TU, WE: RRule.WE, TH: RRule.TH, FR: RRule.FR, SA: RRule.SA };
    options.byweekday = item.recurrence.byWeekday.map((day) => weekdays[day]).filter(Boolean);
  }
  if (item.recurrence.count !== undefined) options.count = item.recurrence.count;
  if (item.recurrence.until) options.until = floatingDate(localDate(item.recurrence.until, "23:59", item.timezone));
  const rule = new RRule(options as any);
  const fromLocal = from.setZone(item.timezone);
  const nextFloating = rule.after(floatingDate(fromLocal), inclusive);
  return nextFloating ? fromFloating(nextFloating, item.timezone).toUTC() as ValidDateTime : null;
}

export function findOccurrence(item: ScheduleItem, from: ValidDateTime = DateTime.utc(), inclusive = true): ValidDateTime | null {
  return item.calendar === "lunar" ? lunarEventAt(item, from, inclusive) : solarEventAt(item, from, inclusive);
}

export function deadlineForOccurrence(item: ScheduleItem, occurrence: ValidDateTime): ValidDateTime | null {
  if (item.deadlineAt !== undefined) {
    const parsed = DateTime.fromISO(item.deadlineAt, { zone: item.timezone });
    return parsed.isValid ? parsed.toUTC() as ValidDateTime : null;
  }
  if (item.deadlineOffsetMinutes !== undefined) {
    return occurrence.plus({ minutes: item.deadlineOffsetMinutes }) as ValidDateTime;
  }
  return null;
}

export interface ReminderTiming {
  target: ReminderTarget;
  targetAt: ValidDateTime;
  triggerAt: ValidDateTime;
}

export function reminderTiming(
  item: ScheduleItem,
  occurrence: ValidDateTime,
  reminder: ReminderInput,
): ReminderTiming | null {
  const target = reminder.target ?? "occurrence";
  const targetAt = target === "deadline" ? deadlineForOccurrence(item, occurrence) : occurrence;
  if (!targetAt) return null;
  return {
    target,
    targetAt,
    triggerAt: targetAt.minus({ minutes: reminder.minutesBefore }) as ValidDateTime,
  };
}

function isAtOrAfter(candidate: ValidDateTime, from: ValidDateTime, inclusive: boolean): boolean {
  return inclusive ? candidate.toMillis() >= from.toMillis() : candidate.toMillis() > from.toMillis();
}

export function nextReminderTiming(
  item: ScheduleItem,
  reminder: ReminderInput,
  from: ValidDateTime,
  inclusive = true,
): (ReminderTiming & { occurrenceAt: ValidDateTime }) | null {
  const target = reminder.target ?? "occurrence";
  let shiftMinutes: number;
  if (target === "occurrence") {
    shiftMinutes = -reminder.minutesBefore;
  } else if (item.deadlineOffsetMinutes !== undefined) {
    shiftMinutes = item.deadlineOffsetMinutes - reminder.minutesBefore;
  } else {
    const occurrenceAt = findOccurrence(item, from, inclusive);
    if (!occurrenceAt) return null;
    const timing = reminderTiming(item, occurrenceAt, reminder);
    return timing && isAtOrAfter(timing.triggerAt, from, inclusive) ? { ...timing, occurrenceAt } : null;
  }

  const occurrenceAt = findOccurrence(
    item,
    from.minus({ minutes: shiftMinutes }) as ValidDateTime,
    inclusive,
  );
  if (!occurrenceAt) return null;
  const timing = reminderTiming(item, occurrenceAt, reminder);
  return timing && isAtOrAfter(timing.triggerAt, from, inclusive) ? { ...timing, occurrenceAt } : null;
}

export function calculateNextRun(item: ScheduleItem, from: ValidDateTime = DateTime.utc(), inclusive = true): ValidDateTime | null {
  const candidates = item.reminders
    .map((reminder) => nextReminderTiming(item, reminder, from, inclusive)?.triggerAt)
    .filter((candidate): candidate is ValidDateTime => candidate !== undefined)
    .sort((a, b) => a.toMillis() - b.toMillis());
  return candidates[0] ?? null;
}

/**
 * recurring 日程在创建/更新时刻的初始触发集合（P1-09 窗口内补发）。
 * 与 nextReminderTiming 不同：只要求目标时刻（occurrence 或 deadline 的 targetAt）
 * 仍在 from 之后，允许 triggerAt 落在过去，使 nextRunAt <= now 时下一分钟
 * scheduler tick 立即补发窗口内被静默跳过的提醒；schedule_occurrences 的
 * occurrence_key 去重保证 at-least-once 不重复。
 * 搜索窗口 = from - targetOffset（target 相对 occurrence 的偏移：
 * occurrence 提醒为 0，deadline 提醒为 deadlineOffsetMinutes），
 * 首个满足 targetAt >= from 的 occurrence 即目标。
 */
function initialCatchUpTriggers(item: ScheduleItem, from: ValidDateTime): ValidDateTime[] {
  const triggers = item.reminders.flatMap((reminder) => {
    const target = reminder.target ?? "occurrence";
    const targetOffset = target === "deadline" && item.deadlineOffsetMinutes !== undefined
      ? item.deadlineOffsetMinutes
      : 0;
    const occurrenceAt = findOccurrence(
      item,
      from.minus({ minutes: targetOffset }) as ValidDateTime,
      true,
    );
    if (!occurrenceAt) return [];
    const timing = reminderTiming(item, occurrenceAt, reminder);
    return timing && timing.targetAt.toMillis() >= from.toMillis() ? [timing.triggerAt] : [];
  });
  return triggers.sort((a, b) => a.toMillis() - b.toMillis());
}

function calculateInitialNextRun(
  item: ScheduleItem,
  occurrence: ValidDateTime | null,
  from: ValidDateTime,
): ValidDateTime | null {
  // once：单一 occurrence 的全部 trigger 恒返回（即使事件已过），保持既有行为。
  if (item.recurrence.frequency === "once") {
    if (!occurrence) return null;
    const triggers = item.reminders
      .map((reminder) => reminderTiming(item, occurrence, reminder)?.triggerAt)
      .filter((trigger): trigger is ValidDateTime => trigger !== undefined)
      .sort((a, b) => a.toMillis() - b.toMillis());
    return triggers[0] ?? null;
  }
  // recurring：允许窗口内补发，见 initialCatchUpTriggers。
  return initialCatchUpTriggers(item, from)[0] ?? null;
}

/** 标量列校验助手（N4/D2-A）：非法时按默认值兜底，不让单行毒化整个查询。 */
function isValidTimeString(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour <= 23 && minute <= 59;
}

function isValidTimezone(zone: string): boolean {
  try {
    return DateTime.fromISO("2020-01-01T00:00:00", { zone }).isValid;
  } catch {
    return false;
  }
}

/** 数值列 hydration 校验（P3-3）：非整数/NaN/越界一律 undefined，由调用方按语义兜底。 */
function finiteIntOrUndefined(value: unknown, min: number, max: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

/** 版本归一化（P2-1）：hydration 与 scheduler 乐观锁共用同一口径。 */
export function normalizeVersion(value: unknown): number {
  return finiteIntOrUndefined(value, 1, Number.MAX_SAFE_INTEGER) ?? 1;
}

// ---------------------------------------------------------------------------
// P3-1：hydration 行级错误日志去重。同一 profileId/id 在窗口内只记一次完整日志，
// 窗口外首次错误仍完整记录；Map 在容量阈值时清扫过期条目，防无界增长。
// ---------------------------------------------------------------------------
const HYDRATION_LOG_WINDOW_MS = 5 * 60 * 1000;
const HYDRATION_LOG_MAX_ENTRIES = 256;
const hydrationErrorLastLoggedAt = new Map<string, number>();

export function logHydrationError(profileId: string, scheduleId: string, error: unknown, now = Date.now()): void {
  const key = `${profileId}:${scheduleId}`;
  const lastLoggedAt = hydrationErrorLastLoggedAt.get(key);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < HYDRATION_LOG_WINDOW_MS) return;
  if (hydrationErrorLastLoggedAt.size >= HYDRATION_LOG_MAX_ENTRIES) {
    for (const [entryKey, loggedAt] of hydrationErrorLastLoggedAt) {
      if (now - loggedAt >= HYDRATION_LOG_WINDOW_MS) hydrationErrorLastLoggedAt.delete(entryKey);
    }
  }
  // N3：硬上限——清理过期后仍达阈值，淘汰最旧条目（有界 TTL），Map 不随活跃错误无界增长。
  while (hydrationErrorLastLoggedAt.size >= HYDRATION_LOG_MAX_ENTRIES) {
    const entries = [...hydrationErrorLastLoggedAt.entries()].sort((a, b) => a[1] - b[1]);
    if (entries.length === 0) break;
    hydrationErrorLastLoggedAt.delete(entries[0][0]);
  }
  hydrationErrorLastLoggedAt.set(key, now);
  console.error(
    `[schedule] hydration failed to derive next occurrence for ${profileId}/${scheduleId}: ` +
    `${error instanceof Error ? error.message : String(error)}`,
  );
}

export function hydrationErrorLogSize(): number {
  return hydrationErrorLastLoggedAt.size;
}

/** 测试专用（N4）：清空 hydration 错误日志去重状态。生产代码不得调用。 */
export function resetHydrationErrorLog(): void {
  hydrationErrorLastLoggedAt.clear();
}

function rowToItem(
  row: Record<string, unknown>,
  findImpl: typeof findOccurrence = findOccurrence,
): ScheduleItem {
  const recurrence = sanitizeRecurrence(parseJson(row.recurrence_json, null), String(row.calendar) as CalendarType);
  // leap_month_policy 列是闰月策略的权威存储：即使 recurrence_json 漂移/缺失也以列值为准，
  // 避免农历闰月日程在读取侧被按普通月计算（二次审查 P0）。
  const rowLeapPolicy = row.leap_month_policy;
  if (typeof rowLeapPolicy === "string"
    && ["normal", "leap", "both", "prefer-leap"].includes(rowLeapPolicy)) {
    // N3/D1-A：列值是权威存储；both/prefer-leap 归一为 normal
    recurrence.leapMonthPolicy = rowLeapPolicy === "leap" ? "leap" : "normal";
  }
  const reminders = sanitizeReminders(parseJson(row.reminders_json, null));

  // N4/D2-A：标量列校验与兜底。timezone/date/time/calendar 损坏时按默认值处理；
  // date+time+timezone 的组合日历合法性（如 2026-02-30）同样兜底为无日期。
  const rawDate = row.date == null ? undefined : String(row.date);
  const rawTime = String(row.time ?? DEFAULT_TIME);
  const rawTimezone = String(row.timezone ?? DEFAULT_ZONE);
  const time = isValidTimeString(rawTime) ? rawTime : DEFAULT_TIME;
  const timezone = isValidTimezone(rawTimezone)
    ? rawTimezone
    : (isValidTimezone(DEFAULT_ZONE) ? DEFAULT_ZONE : "Asia/Shanghai");
  let date = rawDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;
  if (date !== undefined) {
    try {
      localDate(date, time, timezone);
    } catch {
      date = undefined;
    }
  }
  const calendar: CalendarType = row.calendar === "lunar" ? "lunar" : "solar";

  const item: ScheduleItem = {
    id: String(row.id),
    profileId: String(row.profile_id),
    type: String(row.type ?? "todo") as ScheduleType,
    title: String(row.title),
    note: row.note == null ? undefined : String(row.note),
    priority: String(row.priority ?? "normal") as Priority,
    status: String(row.status ?? "active") as ScheduleStatus,
    calendar,
    date,
    time,
    allDay: Boolean(row.all_day),
    timezone,
    // P3-3：数值列损坏（NaN/越界/非整数）按默认值兜底，避免 NaN 位移静默停用日程
    lunarMonth: finiteIntOrUndefined(row.lunar_month, 1, 12),
    lunarDay: finiteIntOrUndefined(row.lunar_day, 1, 30),
    isLeapMonth: row.leap_month_policy === "leap",
    recurrence,
    reminders,
    deadlineAt: row.deadline_at == null ? undefined : String(row.deadline_at),
    deadlineOffsetMinutes: finiteIntOrUndefined(row.deadline_offset_minutes, 0, 60 * 24 * 365),
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at == null ? undefined : String(row.next_run_at),
    version: normalizeVersion(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  // P3-2：fromUtc（输入合法性）与 findOccurrence（逻辑推导）分离——
  // 非法 next_run_at 清空 next-run 派生值（行仍可读）；findOccurrence 的非预期异常
  // 必须记录日志暴露问题，只丢弃派生展示值，不清空 nextRunAt（不让日程静默停调度）。
  if (item.nextRunAt !== undefined) {
    let triggerAt: ValidDateTime;
    try {
      triggerAt = fromUtc(item.nextRunAt);
    } catch {
      item.nextRunAt = undefined;
      return item;
    }
    try {
      const next = findImpl(item, triggerAt, true);
      item.nextOccurrenceSolar = next?.toISO() ?? undefined;
    } catch (error) {
      logHydrationError(item.profileId, item.id, error);
      item.nextOccurrenceSolar = undefined;
    }
  }
  return item;
}

function insertSchedule(profile: ProfileContext, item: ScheduleItem): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, note, priority, status, calendar, date, lunar_month, lunar_day, leap_month_policy, time, all_day, timezone, recurrence_json, reminders_json, deadline_at, deadline_offset_minutes, enabled, next_run_at, version, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    profile.id,
    item.id,
    item.type,
    item.title,
    item.note ?? null,
    item.priority,
    item.status,
    item.calendar,
    item.date ?? null,
    item.lunarMonth ?? null,
    item.lunarDay ?? null,
    item.recurrence.leapMonthPolicy ?? null,
    item.time,
    item.allDay ? 1 : 0,
    item.timezone,
    JSON.stringify(item.recurrence),
    JSON.stringify(item.reminders),
    item.deadlineAt ?? null,
    item.deadlineOffsetMinutes ?? null,
    item.enabled ? 1 : 0,
    item.nextRunAt ?? null,
    item.version,
    item.createdAt,
    item.updatedAt,
  );
}

export function createSchedule(value: ProfileContext | string, input: ScheduleInput): ScheduleItem {
  const profile = context(value);
  const normalized = normalizeInput(input);
  const createdAt = nowIso();
  const id = crypto.randomUUID();
  const base: ScheduleItem = {
    id,
    profileId: profile.id,
    type: normalized.type,
    title: normalized.title.trim(),
    note: normalized.note,
    priority: normalized.priority!,
    status: normalized.status!,
    calendar: normalized.calendar,
    date: normalized.date,
    time: normalized.time,
    allDay: normalized.allDay,
    timezone: normalized.timezone,
    lunarMonth: normalized.lunarMonth,
    lunarDay: normalized.lunarDay,
    isLeapMonth: normalized.recurrence.leapMonthPolicy === "leap",
    recurrence: normalized.recurrence,
    reminders: normalized.reminders,
    deadlineAt: normalized.deadlineAt,
    deadlineOffsetMinutes: normalized.deadlineOffsetMinutes,
    enabled: normalized.status !== "archived",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const now = DateTime.utc();
  const event = findOccurrence(base, now, true);
  base.nextRunAt = calculateInitialNextRun(base, event, now)?.toISO() ?? undefined;
  base.nextOccurrenceSolar = event?.toISO() ?? undefined;
  insertSchedule(profile, base);
  return base;
}

export function listSchedules(value: ProfileContext | string, options: ScheduleListOptions = {}): ScheduleItem[] {
  const profile = context(value);
  const clauses = ["profile_id = ?"];
  const values: unknown[] = [profile.id];
  if (options.type) { clauses.push("type = ?"); values.push(options.type); }
  if (options.status) { clauses.push("status = ?"); values.push(options.status); }
  if (options.from) { clauses.push("COALESCE(next_run_at, '9999-12-31T23:59:59.999Z') >= ?"); values.push(options.from); }
  if (options.to) { clauses.push("COALESCE(next_run_at, '0000-01-01T00:00:00.000Z') <= ?"); values.push(options.to); }
  const limit = Math.min(Math.max(options.upcoming ?? 100, 1), 500);
  const rows = getDatabase().prepare(`SELECT * FROM schedules WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(next_run_at, '9999-12-31T23:59:59.999Z'), created_at LIMIT ${limit}`).all(...values as any[]) as Record<string, unknown>[];
  return rows.map((row) => rowToItem(row));
}

export function getSchedule(value: ProfileContext | string, id: string): ScheduleItem {
  const profile = context(value);
  const row = getDatabase().prepare("SELECT * FROM schedules WHERE profile_id = ? AND id = ?").get(profile.id, id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("schedule not found");
  return rowToItem(row);
}

export function updateSchedule(value: ProfileContext | string, id: string, changes: Partial<ScheduleInput>): ScheduleItem {
  const profile = context(value);
  // N1：current（经 rowToItem hydration 归一化）与乐观锁 WHERE 用的原始 version
  // 来自同一次 SELECT 快照，消除 getSchedule+rawVersion 两次独立读取的 TOCTOU 窗口；
  // 写回统一用归一化后的值自愈（N2：WHERE 用 version IS ? 以匹配 NULL）。
  const rawRow = getDatabase().prepare(
    "SELECT * FROM schedules WHERE profile_id = ? AND id = ?",
  ).get(profile.id, id) as Record<string, unknown> | undefined;
  if (!rawRow) throw new Error("schedule not found");
  const current = rowToItem(rawRow);
  const rawVersion = rawRow.version as number | null;
  const { recurrence: recurrenceChange, ...restChanges } = changes;
  // P2-12：recurrence 为 plain object 时与现有规则深合并（部分更新）；
  // 为字符串枚举（如 "daily"）时整体替换频率规则。
  const mergedRecurrence: ScheduleInput["recurrence"] = recurrenceChange === undefined
    ? current.recurrence
    : typeof recurrenceChange === "string"
      ? recurrenceChange
      : { ...current.recurrence, ...recurrenceChange };
  const merged: ScheduleInput = {
    type: current.type,
    title: current.title,
    note: current.note,
    priority: current.priority,
    status: current.status,
    calendar: current.calendar,
    date: current.date,
    time: current.time,
    allDay: current.allDay,
    timezone: current.timezone,
    lunarMonth: current.lunarMonth,
    lunarDay: current.lunarDay,
    isLeapMonth: current.isLeapMonth,
    leapMonthPolicy: current.recurrence.leapMonthPolicy,
    recurrence: mergedRecurrence,
    reminders: current.reminders,
    deadlineAt: current.deadlineAt,
    deadlineOffsetMinutes: current.deadlineOffsetMinutes,
    ...restChanges,
  };
  const normalized = normalizeInput(merged);
  const updatedAt = nowIso();
  const next: ScheduleItem = {
    ...current,
    ...normalized,
    title: normalized.title.trim(),
    recurrence: normalized.recurrence,
    reminders: normalized.reminders,
    updatedAt,
    version: current.version + 1,
    enabled: normalized.status !== "archived",
  };
  const now = DateTime.utc();
  const event = findOccurrence(next, now, true);
  next.nextRunAt = calculateInitialNextRun(next, event, now)?.toISO() ?? undefined;
  next.nextOccurrenceSolar = event?.toISO() ?? undefined;
  const result = getDatabase().prepare(`
    UPDATE schedules SET type=?, title=?, note=?, priority=?, status=?, calendar=?, date=?, lunar_month=?, lunar_day=?, leap_month_policy=?, time=?, all_day=?, timezone=?, recurrence_json=?, reminders_json=?, deadline_at=?, deadline_offset_minutes=?, enabled=?, next_run_at=?, version=?, updated_at=?
    WHERE profile_id=? AND id=? AND version IS ?
  `).run(
    next.type, next.title, next.note ?? null, next.priority, next.status, next.calendar, next.date ?? null, next.lunarMonth ?? null, next.lunarDay ?? null,
    next.recurrence.leapMonthPolicy ?? null, next.time, next.allDay ? 1 : 0, next.timezone, JSON.stringify(next.recurrence), JSON.stringify(next.reminders), next.deadlineAt ?? null, next.deadlineOffsetMinutes ?? null, next.enabled ? 1 : 0,
    next.nextRunAt ?? null, next.version, next.updatedAt, profile.id, id, rawVersion,
  ) as { changes: number };
  if (!result.changes) throw new Error("schedule update conflict");
  return next;
}

export function deleteSchedule(value: ProfileContext | string, id: string): void {
  const profile = context(value);
  const result = getDatabase().prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(profile.id, id) as { changes: number };
  if (!result.changes) throw new Error("schedule not found");
}

export function completeSchedule(value: ProfileContext | string, id: string, occurrenceKey?: string): ScheduleItem {
  const profile = context(value);
  const item = getSchedule(profile, id);
  let occurrenceAt = occurrenceKey?.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(?::.*)?$/)?.[1];
  if (!occurrenceAt && item.nextRunAt) {
    const triggerAt = fromUtc(item.nextRunAt);
    occurrenceAt = item.reminders
      .map((reminder) => nextReminderTiming(item, reminder, triggerAt, true))
      .find((timing) => timing?.triggerAt.equals(triggerAt))
      ?.occurrenceAt.toISO() ?? undefined;
  }
  occurrenceAt ??= item.nextRunAt ?? nowIso();
  getDatabase().prepare("INSERT OR REPLACE INTO schedule_occurrences(profile_id, schedule_id, occurrence_key, occurrence_at, status) VALUES(?, ?, ?, ?, 'completed')").run(profile.id, id, occurrenceAt, occurrenceAt);
  if (item.recurrence.frequency === "once") return updateSchedule(profile, id, { status: "completed" });
  return item;
}

export function hydrateRow(
  row: Record<string, unknown>,
  findImpl: typeof findOccurrence = findOccurrence,
): ScheduleItem {
  return rowToItem(row, findImpl);
}

export function nextEventAfter(item: ScheduleItem, event: ValidDateTime): ValidDateTime | null {
  return findOccurrence(item, event.plus({ milliseconds: 1 }), true);
}

export function reminderMinutes(item: ScheduleItem): number[] {
  return item.reminders.map((reminder) => reminder.minutesBefore).sort((a, b) => b - a);
}
