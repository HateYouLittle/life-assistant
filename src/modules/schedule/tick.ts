import { DateTime } from "luxon";
import { getDatabase } from "../../core/database.js";
import { publishNotification } from "../../core/notification-publisher.js";
import {
  calculateNextRun,
  deadlineForOccurrence,
  holidayAwareRuleFinished,
  hydrateRow,
  isScheduleOccurrenceCompleted,
  nextReminderTiming,
  normalizeVersion,
} from "./service.js";
import { buildScheduleReminderNotification } from "./notification.js";
import type { ScheduleItem } from "./types.js";

/**
 * 调度扫描（scheduler 每分钟 tick 的 schedule 实现）。
 *
 * 这段逻辑原内联在核心 scheduler.ts 中；按"模块知识归模块"的原则整体迁入，
 * 经由 AssistantModule.tick 扩展点被 scheduler 调用。SQL 判定统一取自
 * service.ts 单点实现，不再存在双份手写副本。
 */

function reminderId(reminder: { id?: string; minutesBefore: number }, index: number): string {
  return reminder.id ?? `reminder-${index + 1}`;
}

interface DueCursor {
  nextRunAt: string;
  profileId: string;
  id: string;
}

function dueRows(at: Date, cursor?: DueCursor): Record<string, unknown>[] {
  const db = getDatabase();
  if (!cursor) {
    return db.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at, profile_id, id LIMIT 500
    `).all(at.toISOString()) as Record<string, unknown>[];
  }
  return db.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      AND (
        next_run_at > ?
        OR (next_run_at = ? AND profile_id > ?)
        OR (next_run_at = ? AND profile_id = ? AND id > ?)
      )
    ORDER BY next_run_at, profile_id, id LIMIT 500
  `).all(
    at.toISOString(),
    cursor.nextRunAt,
    cursor.nextRunAt,
    cursor.profileId,
    cursor.nextRunAt,
    cursor.profileId,
    cursor.id,
  ) as Record<string, unknown>[];
}

async function processDue(item: ScheduleItem, at: DateTime<true>): Promise<void> {
  if (!item.nextRunAt) return;
  const db = getDatabase();
  // 发布前重读版本：若 MCP 工具已并发修改（版本推进），放弃陈旧快照，
  // 下个 tick 会用新版本重新评估，避免按过期内容发布提醒。
  // P2-1：比较用与 hydration 相同的归一化口径（normalizeVersion），
  // 脏行 version=0/-1/1.5 归一为 1 后与 item.version 一致，不再被永久判 stale。
  const fresh = db.prepare(
    "SELECT version FROM schedules WHERE profile_id = ? AND id = ?",
  ).get(item.profileId, item.id) as { version: number } | undefined;
  if (!fresh || normalizeVersion(fresh.version) !== item.version) {
    console.warn(
      `[schedule] skipped stale snapshot ${item.profileId}/${item.id} ` +
        `(db version ${fresh?.version ?? "missing"} != snapshot version ${item.version})`,
    );
    return;
  }
  const triggerAt = DateTime.fromISO(item.nextRunAt, { zone: "utc" }).toUTC() as DateTime<true>;
  const reminders = item.reminders.length ? item.reminders : [{ id: "reminder-1", minutesBefore: 0 }];
  for (let index = 0; index < reminders.length; index += 1) {
    const reminder = reminders[index];
    const timing = nextReminderTiming(item, reminder, triggerAt, true);
    if (!timing || timing.triggerAt > at) continue;
    const id = reminderId(reminder, index);
    const occurrenceIso = timing.occurrenceAt.toISO();
    if (!occurrenceIso || isScheduleOccurrenceCompleted(item.profileId, item.id, occurrenceIso)) continue;
    const key = `${occurrenceIso}:${timing.target}:${id}`;
    const legacyOccurrenceKey = timing.target === "occurrence" ? `${occurrenceIso}:${id}` : undefined;
    const existing = db.prepare(`
      SELECT 1 FROM schedule_occurrences
      WHERE profile_id = ? AND schedule_id = ?
        AND (occurrence_key = ? OR occurrence_key = ?)
    `).get(item.profileId, item.id, key, legacyOccurrenceKey ?? key);
    if (!existing) {
      const legacyDedupeKey = legacyOccurrenceKey
        ? `schedule:${item.profileId}:${item.id}:${legacyOccurrenceKey}`
        : undefined;
      const legacyNotification = legacyDedupeKey
        ? db.prepare(`
            SELECT 1 FROM profile_notifications
            WHERE profile_id = ? AND dedupe_key = ?
          `).get(item.profileId, legacyDedupeKey)
        : undefined;
      if (!legacyNotification) {
        // 渲染参考时间钉在计划触发时刻：tick 墙钟恒晚于 trigger（triggerAt > at 会被跳过），
        // 准时提醒若按墙钟渲染必然落入"已逾期 1 分钟"分支；亚分钟抖动吸收后显示"现在"。
        // 迟到超过 1 分钟（停机补发）保留墙钟，让相对时间如实反映逾期时长。
        const referenceAt = at.toMillis() - timing.triggerAt.toMillis() <= 60_000
          ? timing.triggerAt
          : at;
        const notification = buildScheduleReminderNotification({
          item,
          occurrenceKey: key,
          occurrenceAt: occurrenceIso,
          deadlineAt: deadlineForOccurrence(item, timing.occurrenceAt)?.toISO(),
          target: timing.target,
          reminderId: id,
          reminderMinutes: reminder.minutesBefore,
          generatedAt: referenceAt.toISO(),
        });
        await publishNotification(notification);
      }
      db.prepare("INSERT OR IGNORE INTO schedule_occurrences(profile_id, schedule_id, occurrence_key, occurrence_at, status) VALUES(?, ?, ?, ?, 'notified')")
        .run(item.profileId, item.id, key, occurrenceIso);
    }
  }

  let cursor = at.plus({ milliseconds: 1 }) as DateTime<true>;
  let nextRun: DateTime<true> | null = null;
  while (true) {
    const candidate = calculateNextRun(item, cursor, true);
    if (!candidate) break;
    const hasIncompleteOccurrence = item.reminders.some((reminder) => {
      const timing = nextReminderTiming(item, reminder, candidate, true);
      return timing?.triggerAt.equals(candidate)
        && !isScheduleOccurrenceCompleted(item.profileId, item.id, timing.occurrenceAt.toISO());
    });
    if (hasIncompleteOccurrence) {
      nextRun = candidate;
      break;
    }
    cursor = candidate.plus({ milliseconds: 1 }) as DateTime<true>;
  }
  // workday/holiday：无数据区间算不出 next run 时保持 active 并停用，等新一年节假日数据
  // 入库后由 reconcileHolidaySchedules 恢复；until/count 真正耗尽才标记 completed。
  const nextStatus = nextRun
    ? item.status
    : (item.recurrence.frequency === "workday" || item.recurrence.frequency === "holiday")
      ? (holidayAwareRuleFinished(item, at) ? "completed" : item.status)
      : "completed";
  // P2-1：写回用归一化后的版本（脏行 version=0 → 2，自愈），WHERE 用原始列值防并发冲突。
  // N2：WHERE 用 version IS ? —— SQLite 的 IS 可匹配 NULL，NULL 脏行同样命中并自愈。
  const nextVersion = normalizeVersion(fresh.version) + 1;
  const updated = db.prepare("UPDATE schedules SET next_run_at = ?, enabled = ?, status = ?, version = ?, updated_at = ? WHERE profile_id = ? AND id = ? AND version IS ?").run(
    nextRun?.toISO() ?? null,
    nextRun ? 1 : 0,
    nextStatus,
    nextVersion,
    new Date().toISOString(),
    item.profileId,
    item.id,
    fresh.version,
  ) as { changes: number };
  if (updated.changes !== 1) {
    console.warn(
      `[schedule] version conflict updating ${item.profileId}/${item.id}: ` +
        "a concurrent update won; a stale notification may have been published and will not repeat",
    );
  }
}

export async function runDueSchedules(at = new Date()): Promise<void> {
  const current = DateTime.fromJSDate(at, { zone: "utc" }) as DateTime<true>;
  const errors: unknown[] = [];
  let cursor: DueCursor | undefined;
  while (true) {
    const rows = dueRows(at, cursor);
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        await processDue(hydrateRow(row), current);
      } catch (error) {
        errors.push(error);
      }
    }
    const last = rows.at(-1) as Record<string, unknown>;
    cursor = {
      nextRunAt: String(last.next_run_at),
      profileId: String(last.profile_id),
      id: String(last.id),
    };
    if (rows.length < 500) break;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} due schedules failed`);
}
