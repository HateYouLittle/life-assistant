import crypto from "node:crypto";
import rrulePkg from "rrule";
import { DateTime } from "luxon";
import { Lunar, LunarYear } from "lunar-javascript";
import { getDatabase } from "../../core/database.js";
import { requireProfileContext, type ProfileContext } from "../../core/profile.js";
import type {
  CalendarType,
  Frequency,
  LeapMonthPolicy,
  Priority,
  RecurrenceRule,
  ReminderInput,
  ScheduleInput,
  ScheduleItem,
  ScheduleListOptions,
  ScheduleStatus,
  ScheduleType,
} from "./types.js";

const { RRule } = rrulePkg as unknown as { RRule: any };
const DEFAULT_ZONE = "Asia/Shanghai";
const DEFAULT_TIME = "09:00";
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
  const policy = input.leapMonthPolicy ?? (input.isLeapMonth ? "leap" : "normal");
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
  return reminders.map((reminder, index) => ({
    id: reminder.id ?? `reminder-${index + 1}`,
    minutesBefore: reminder.minutesBefore,
  }));
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
  return {
    ...input,
    type,
    calendar,
    timezone,
    time,
    allDay: input.allDay ?? !input.time,
    recurrence,
    reminders,
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

function maxReminder(item: ScheduleItem): number {
  return Math.max(...item.reminders.map((reminder) => reminder.minutesBefore), 0);
}

export function calculateNextRun(item: ScheduleItem, from: ValidDateTime = DateTime.utc(), inclusive = true): ValidDateTime | null {
  const event = findOccurrence(item, from.plus({ minutes: maxReminder(item) }), inclusive);
  return event?.minus({ minutes: maxReminder(item) }) ?? null;
}

function rowToItem(row: Record<string, unknown>): ScheduleItem {
  const recurrence = parseJson<RecurrenceRule>(row.recurrence_json, {
    frequency: "once",
    interval: 1,
    calendar: String(row.calendar) as CalendarType,
  });
  const reminders = parseJson<ReminderInput[]>(row.reminders_json, [{ minutesBefore: 0, id: "reminder-1" }]);
  const item: ScheduleItem = {
    id: String(row.id),
    profileId: String(row.profile_id),
    type: String(row.type ?? "todo") as ScheduleType,
    title: String(row.title),
    note: row.note == null ? undefined : String(row.note),
    priority: String(row.priority ?? "normal") as Priority,
    status: String(row.status ?? "active") as ScheduleStatus,
    calendar: String(row.calendar) as CalendarType,
    date: row.date == null ? undefined : String(row.date),
    time: String(row.time ?? DEFAULT_TIME),
    allDay: Boolean(row.all_day),
    timezone: String(row.timezone ?? DEFAULT_ZONE),
    lunarMonth: row.lunar_month == null ? undefined : Number(row.lunar_month),
    lunarDay: row.lunar_day == null ? undefined : Number(row.lunar_day),
    isLeapMonth: row.leap_month_policy === "leap",
    recurrence,
    reminders,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at == null ? undefined : String(row.next_run_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  const next = item.nextRunAt ? findOccurrence(item, fromUtc(item.nextRunAt), true) : null;
  if (next) item.nextOccurrenceSolar = next.toISO() ?? undefined;
  return item;
}

function insertSchedule(profile: ProfileContext, item: ScheduleItem): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, note, priority, status, calendar, date, lunar_month, lunar_day, leap_month_policy, time, all_day, timezone, recurrence_json, reminders_json, enabled, next_run_at, version, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    enabled: normalized.status !== "archived",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const event = findOccurrence(base, DateTime.utc(), true);
  base.nextRunAt = event?.minus({ minutes: maxReminder(base) }).toISO() ?? undefined;
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
  return rows.map(rowToItem);
}

export function getSchedule(value: ProfileContext | string, id: string): ScheduleItem {
  const profile = context(value);
  const row = getDatabase().prepare("SELECT * FROM schedules WHERE profile_id = ? AND id = ?").get(profile.id, id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("schedule not found");
  return rowToItem(row);
}

export function updateSchedule(value: ProfileContext | string, id: string, changes: Partial<ScheduleInput>): ScheduleItem {
  const profile = context(value);
  const current = getSchedule(profile, id);
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
    recurrence: current.recurrence,
    reminders: current.reminders,
    ...changes,
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
  const event = findOccurrence(next, DateTime.utc(), true);
  next.nextRunAt = event?.minus({ minutes: maxReminder(next) }).toISO() ?? undefined;
  next.nextOccurrenceSolar = event?.toISO() ?? undefined;
  const result = getDatabase().prepare(`
    UPDATE schedules SET type=?, title=?, note=?, priority=?, status=?, calendar=?, date=?, lunar_month=?, lunar_day=?, leap_month_policy=?, time=?, all_day=?, timezone=?, recurrence_json=?, reminders_json=?, enabled=?, next_run_at=?, version=?, updated_at=?
    WHERE profile_id=? AND id=? AND version=?
  `).run(
    next.type, next.title, next.note ?? null, next.priority, next.status, next.calendar, next.date ?? null, next.lunarMonth ?? null, next.lunarDay ?? null,
    next.recurrence.leapMonthPolicy ?? null, next.time, next.allDay ? 1 : 0, next.timezone, JSON.stringify(next.recurrence), JSON.stringify(next.reminders), next.enabled ? 1 : 0,
    next.nextRunAt ?? null, next.version, next.updatedAt, profile.id, id, current.version,
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
  const key = occurrenceKey ?? item.nextRunAt ?? nowIso();
  const occurrenceAt = item.nextRunAt ?? nowIso();
  getDatabase().prepare("INSERT OR REPLACE INTO schedule_occurrences(profile_id, schedule_id, occurrence_key, occurrence_at, status) VALUES(?, ?, ?, ?, 'completed')").run(profile.id, id, key, occurrenceAt);
  if (item.recurrence.frequency === "once") return updateSchedule(profile, id, { status: "completed" });
  return item;
}

export function hydrateRow(row: Record<string, unknown>): ScheduleItem {
  return rowToItem(row);
}

export function nextEventAfter(item: ScheduleItem, event: ValidDateTime): ValidDateTime | null {
  return findOccurrence(item, event.plus({ milliseconds: 1 }), true);
}

export function reminderMinutes(item: ScheduleItem): number[] {
  return item.reminders.map((reminder) => reminder.minutesBefore).sort((a, b) => b - a);
}
