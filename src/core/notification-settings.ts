import { DateTime } from "luxon";
import { config } from "../config.js";
import { getDatabase } from "./database.js";
import { requireProfileContext } from "./profile.js";

/** Profile 级静默时段：窗口内 scheduler 不尝试主动投递（notify.pull 不受影响）。 */
export interface QuietHours {
  /** 本地时间 HH:mm（含），跨午夜窗口如 22:00 */
  start: string;
  /** 本地时间 HH:mm（不含），如 07:00 */
  end: string;
  timezone: string;
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && TIME_OF_DAY.test(value);
}

function parseMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** 保存前校验：HH:mm 格式且 start != end（相等窗口语义不明，直接拒绝）。 */
export function validateQuietHours(start: string, end: string, timezone?: string): QuietHours {
  if (!isValidTimeOfDay(start) || !isValidTimeOfDay(end)) {
    throw new Error("静默时段 start/end 必须是 HH:mm 格式（00:00–23:59）");
  }
  if (start === end) {
    throw new Error("静默时段 start 与 end 不能相同（例如 22:00–07:00 表示每晚静默到次日早上）");
  }
  const zone = timezone?.trim() || config.timezone;
  if (!DateTime.now().setZone(zone).isValid) {
    throw new Error(`无效时区：${zone}`);
  }
  return { start, end, timezone: zone };
}

export function getQuietHours(profileId: string): QuietHours | null {
  const row = getDatabase().prepare(
    "SELECT quiet_start, quiet_end, timezone FROM profile_settings WHERE profile_id = ?",
  ).get(requireProfileContext(profileId).id) as
    { quiet_start: string | null; quiet_end: string | null; timezone: string | null } | undefined;
  if (!row?.quiet_start || !row.quiet_end || !row.timezone) return null;
  if (!isValidTimeOfDay(row.quiet_start) || !isValidTimeOfDay(row.quiet_end)) return null;
  return { start: row.quiet_start, end: row.quiet_end, timezone: row.timezone };
}

export function saveQuietHours(profileId: string, start: string, end: string, timezone?: string): QuietHours {
  const profile = requireProfileContext(profileId);
  const quiet = validateQuietHours(start, end, timezone);
  const db = getDatabase();
  const time = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO profiles(profile_id, created_at) VALUES(?, ?)").run(profile.id, time);
  db.prepare(`
    INSERT INTO profile_settings(profile_id, quiet_start, quiet_end, timezone, updated_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      quiet_start = excluded.quiet_start,
      quiet_end = excluded.quiet_end,
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  `).run(profile.id, quiet.start, quiet.end, quiet.timezone, time);
  return quiet;
}

export function clearQuietHours(profileId: string): boolean {
  const profile = requireProfileContext(profileId);
  const result = getDatabase().prepare(
    "DELETE FROM profile_settings WHERE profile_id = ? AND quiet_start IS NOT NULL",
  ).run(profile.id) as { changes: number };
  return result.changes > 0;
}

/**
 * 判断 at 是否处于静默窗口内。start <= end 为当日窗口（含 start、不含 end）；
 * start > end 为跨午夜窗口（如 22:00–07:00）。end=00:00 视为次日 0 点（即静默到午夜）。
 */
export function isQuietAt(quiet: QuietHours, at: Date): boolean {
  const local = DateTime.fromJSDate(at).setZone(quiet.timezone);
  if (!local.isValid) return false;
  const minutes = local.hour * 60 + local.minute;
  const start = parseMinutes(quiet.start);
  const end = quiet.end === "00:00" ? 24 * 60 : parseMinutes(quiet.end);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/** 当前处于静默时段的全部 Profile（scheduler 投递循环调用）。 */
export function quietProfileIds(at = new Date()): Set<string> {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT profile_id, quiet_start, quiet_end, timezone FROM profile_settings WHERE quiet_start IS NOT NULL AND quiet_end IS NOT NULL",
  ).all() as Array<{ profile_id: string; quiet_start: string; quiet_end: string; timezone: string | null }>;
  const result = new Set<string>();
  for (const row of rows) {
    if (!isValidTimeOfDay(row.quiet_start) || !isValidTimeOfDay(row.quiet_end) || !row.timezone) continue;
    if (isQuietAt({ start: row.quiet_start, end: row.quiet_end, timezone: row.timezone }, at)) {
      result.add(row.profile_id);
    }
  }
  return result;
}
