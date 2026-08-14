import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron, { type ScheduledTask } from "node-cron";
import { DateTime } from "luxon";
import { getModules } from "./modules/index.js";
import { getDatabase } from "./core/database.js";
import { publishNotification } from "./core/notification-publisher.js";
import { deliverPendingProfileNotifications, notify, publishProfile, type DeliverySummary } from "./core/notifier.js";
import { notifyModule } from "./core/notify-module.js";
import { ok, type AssistantModule } from "./core/registry.js";
import { buildScheduleReminderNotification } from "./modules/schedule/notification.js";
import { calculateNextRun, deadlineForOccurrence, hydrateRow, nextReminderTiming, normalizeVersion } from "./modules/schedule/service.js";
import type { ScheduleItem } from "./modules/schedule/types.js";

export { notifyModule };

const LEASE_NAME = "scheduler";
const LEASE_TTL_MS = 2 * 60 * 1000;

function isoNow(): string {
  return new Date().toISOString();
}

export function acquireSchedulerLease(owner: string, at = new Date()): boolean {
  const db = getDatabase();
  const timestamp = at.toISOString();
  db.prepare("INSERT OR IGNORE INTO scheduler_lease(name, owner, acquired_at) VALUES(?, ?, ?)").run(LEASE_NAME, owner, timestamp);
  const row = db.prepare("SELECT owner, acquired_at FROM scheduler_lease WHERE name = ?").get(LEASE_NAME) as { owner: string; acquired_at: string } | undefined;
  if (!row) return false;
  if (row.owner === owner) {
    const result = db.prepare("UPDATE scheduler_lease SET acquired_at = ? WHERE name = ? AND owner = ?").run(timestamp, LEASE_NAME, owner) as { changes: number };
    return result.changes === 1;
  }
  const age = at.getTime() - Date.parse(row.acquired_at);
  if (age > LEASE_TTL_MS) {
    const result = db.prepare("UPDATE scheduler_lease SET owner = ?, acquired_at = ? WHERE name = ? AND owner = ? AND acquired_at = ?").run(owner, timestamp, LEASE_NAME, row.owner, row.acquired_at) as { changes: number };
    return result.changes === 1;
  }
  return false;
}

export function refreshSchedulerLease(owner: string, at = new Date()): boolean {
  const result = getDatabase().prepare(
    "UPDATE scheduler_lease SET acquired_at = ? WHERE name = ? AND owner = ?",
  ).run(at.toISOString(), LEASE_NAME, owner) as { changes: number };
  return result.changes === 1;
}

export function releaseSchedulerLease(owner: string): void {
  getDatabase().prepare("DELETE FROM scheduler_lease WHERE name = ? AND owner = ?").run(LEASE_NAME, owner);
}

function reminderId(reminder: { id?: string; minutesBefore: number }, index: number): string {
  return reminder.id ?? `reminder-${index + 1}`;
}

function occurrenceCompleted(item: ScheduleItem, occurrenceAt: string): boolean {
  return Boolean(getDatabase().prepare(`
    SELECT 1 FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ? AND status = 'completed'
      AND (occurrence_key = ? OR occurrence_key LIKE ?)
    LIMIT 1
  `).get(item.profileId, item.id, occurrenceAt, `${occurrenceAt}:%`));
}

function calculateNextIncompleteRun(
  item: ScheduleItem,
  from: DateTime<true>,
): DateTime<true> | null {
  let cursor = from;
  while (true) {
    const candidate = calculateNextRun(item, cursor, true);
    if (!candidate) return null;
    const hasIncompleteOccurrence = item.reminders.some((reminder) => {
      const timing = nextReminderTiming(item, reminder, candidate, true);
      return timing?.triggerAt.equals(candidate)
        && !occurrenceCompleted(item, timing.occurrenceAt.toISO());
    });
    if (hasIncompleteOccurrence) return candidate;
    cursor = candidate.plus({ milliseconds: 1 }) as DateTime<true>;
  }
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
    if (occurrenceCompleted(item, occurrenceIso)) continue;
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
        const notification = buildScheduleReminderNotification({
          item,
          occurrenceKey: key,
          occurrenceAt: occurrenceIso,
          deadlineAt: deadlineForOccurrence(item, timing.occurrenceAt)?.toISO(),
          target: timing.target,
          reminderId: id,
          reminderMinutes: reminder.minutesBefore,
          generatedAt: at.toISO(),
        });
        await publishNotification(notification, { publishProfile });
      }
      db.prepare("INSERT OR IGNORE INTO schedule_occurrences(profile_id, schedule_id, occurrence_key, occurrence_at, status) VALUES(?, ?, ?, ?, 'notified')")
        .run(item.profileId, item.id, key, occurrenceIso);
    }
  }

  const nextRun = calculateNextIncompleteRun(item, at.plus({ milliseconds: 1 }) as DateTime<true>);
  // P2-1：写回用归一化后的版本（脏行 version=0 → 2，自愈），WHERE 用原始列值防并发冲突。
  const nextVersion = normalizeVersion(fresh.version) + 1;
  const updated = db.prepare("UPDATE schedules SET next_run_at = ?, enabled = ?, status = ?, version = ?, updated_at = ? WHERE profile_id = ? AND id = ? AND version = ?").run(
    nextRun?.toISO() ?? null,
    nextRun ? 1 : 0,
    nextRun ? item.status : "completed",
    nextVersion,
    isoNow(),
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

export async function runSchedulerTick(at = new Date(), fetchImpl: typeof fetch = fetch): Promise<DeliverySummary> {
  let scheduleError: unknown;
  try {
    await runDueSchedules(at);
  } catch (error) {
    scheduleError = error;
  }
  const summary = await deliverPendingProfileNotifications({ at, fetchImpl });
  if (scheduleError) throw scheduleError;
  return summary;
}

export interface SchedulerHandle {
  stop(): void;
  owner: string;
  started: boolean;
}

export function startScheduler(): SchedulerHandle {
  const owner = `${process.pid}-${crypto.randomUUID()}`;
  if (!acquireSchedulerLease(owner)) return { owner, started: false, stop: () => undefined };
  const tasks: ScheduledTask[] = [];
  let stopped = false;
  let activeRuns = 0;
  let leaseReleased = false;
  let heartbeat: NodeJS.Timeout;
  const releaseIfIdle = (): void => {
    if (!stopped || activeRuns !== 0 || leaseReleased) return;
    releaseSchedulerLease(owner);
    leaseReleased = true;
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    for (const task of tasks) task.stop();
    releaseIfIdle();
  };
  const fence = (): boolean => {
    if (stopped) return false;
    if (refreshSchedulerLease(owner)) return true;
    console.error("[scheduler] lease lost; stopping all scheduled work");
    stop();
    return false;
  };
  const runFenced = async (handler: () => Promise<void>): Promise<void> => {
    if (!fence()) return;
    activeRuns += 1;
    try {
      await handler();
    } finally {
      activeRuns -= 1;
      releaseIfIdle();
    }
  };
  heartbeat = setInterval(() => {
    fence();
  }, 60_000);
  heartbeat.unref();
  for (const module of getModules()) {
    for (const job of module.jobs ?? []) {
      const task = cron.schedule(job.cron, async () => {
        await runFenced(async () => {
          try {
            await job.handler({ notify });
          } catch (error) {
            console.error(`[job ${module.name}.${job.name}] failed:`, error);
          }
        });
      }, job.timezone ? { timezone: job.timezone } : undefined);
      tasks.push(task);
      console.log(`[scheduler] registered ${module.name}.${job.name} cron="${job.cron}"`);
    }
  }
  let tickRunning = false;
  tasks.push(cron.schedule("* * * * *", async () => {
    // 投递最坏 100×10s，比 tick 周期长；跳过重叠 tick 避免故障期负载放大。
    if (tickRunning) return;
    tickRunning = true;
    try {
      await runFenced(async () => {
        try {
          await runSchedulerTick();
        } catch (error) {
          console.error("[job schedule.tick] failed:", error);
        }
      });
    } finally {
      tickRunning = false;
    }
  }));
  console.log(`[scheduler] started, ${tasks.length} jobs from ${getModules().length} modules.`);
  return {
    owner,
    started: true,
    stop,
  };
}

async function main(): Promise<void> {
  const handle = startScheduler();
  if (!handle.started) {
    console.error("[scheduler] lease not acquired: another scheduler owns this DATA_DIR; exiting (retry after lease TTL).");
    process.exitCode = 1;
    return;
  }
  const shutdown = (): void => {
    handle.stop();
    process.exitCode = 0;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main();
}
