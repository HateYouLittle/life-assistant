import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DateTime } from "luxon";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-scheduler-deadline-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "scheduler-deadline";
delete process.env.PROFILE_PUSH_ROUTES_JSON;

const { requireProfileContext } = await import("../src/core/profile.js");
const { getDatabase, resetDatabaseForTests } = await import("../src/core/database.js");
const { completeSchedule, createSchedule } = await import("../src/modules/schedule/service.js");
const { runDueSchedules } = await import("../src/scheduler.js");

const db = getDatabase();
const profile = requireProfileContext("scheduler-deadline");

test.after(() => {
  resetDatabaseForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function notices(scheduleId: string): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT title, body, dedupe_key
    FROM profile_notifications
    WHERE profile_id = ? AND dedupe_key LIKE ?
    ORDER BY dedupe_key
  `).all(profile.id, `schedule:${profile.id}:${scheduleId}:%`) as Array<Record<string, unknown>>;
}

test("one-time occurrence and deadline reminders run independently", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "two target reminder",
    calendar: "solar",
    date: "2099-05-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    deadlineAt: "2099-05-01T11:00",
    reminders: [
      { id: "start", minutesBefore: 0, target: "occurrence" },
      { id: "due", minutesBefore: 0, target: "deadline" },
    ],
  });

  await runDueSchedules(new Date("2099-05-01T01:00:00.000Z"));
  assert.deepEqual(notices(item.id).map((row) => row.dedupe_key), [
    `schedule:${profile.id}:${item.id}:2099-05-01T01:00:00.000Z:occurrence:start`,
  ]);
  let scheduleRow = db.prepare("SELECT next_run_at, enabled, status FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...scheduleRow }, {
    next_run_at: "2099-05-01T03:00:00.000Z",
    enabled: 1,
    status: "active",
  });

  await runDueSchedules(new Date("2099-05-01T03:00:00.000Z"));
  assert.deepEqual(notices(item.id).map((row) => row.dedupe_key), [
    `schedule:${profile.id}:${item.id}:2099-05-01T01:00:00.000Z:deadline:due`,
    `schedule:${profile.id}:${item.id}:2099-05-01T01:00:00.000Z:occurrence:start`,
  ]);
  scheduleRow = db.prepare("SELECT next_run_at, enabled, status FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...scheduleRow }, { next_run_at: null, enabled: 0, status: "completed" });
});

test("recurring deadlines stay attached to each occurrence and do not complete the schedule", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "daily deadline",
    calendar: "solar",
    date: "2099-06-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    deadlineOffsetMinutes: 120,
    reminders: [
      { id: "start", minutesBefore: 0, target: "occurrence" },
      { id: "due", minutesBefore: 0, target: "deadline" },
    ],
  });

  await runDueSchedules(new Date("2099-06-01T01:00:00.000Z"));
  await runDueSchedules(new Date("2099-06-01T03:00:00.000Z"));
  await runDueSchedules(new Date("2099-06-02T01:00:00.000Z"));

  assert.deepEqual(notices(item.id).map((row) => row.dedupe_key), [
    `schedule:${profile.id}:${item.id}:2099-06-01T01:00:00.000Z:deadline:due`,
    `schedule:${profile.id}:${item.id}:2099-06-01T01:00:00.000Z:occurrence:start`,
    `schedule:${profile.id}:${item.id}:2099-06-02T01:00:00.000Z:occurrence:start`,
  ]);
  const scheduleRow = db.prepare("SELECT enabled, status FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...scheduleRow }, { enabled: 1, status: "active" });
});

test("completing a recurring occurrence suppresses all of its reminders and preserves the next occurrence", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "completed daily occurrence",
    calendar: "solar",
    date: "2099-06-10",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    deadlineOffsetMinutes: 120,
    reminders: [
      { id: "early", minutesBefore: 60, target: "occurrence" },
      { id: "due", minutesBefore: 0, target: "deadline" },
    ],
  });

  assert.equal(item.nextRunAt, "2099-06-10T00:00:00.000Z");
  completeSchedule(profile, item.id);
  await runDueSchedules(new Date("2099-06-10T03:00:00.000Z"));

  assert.deepEqual(notices(item.id), []);
  let scheduleRow = db.prepare("SELECT next_run_at, enabled, status FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...scheduleRow }, {
    next_run_at: "2099-06-11T00:00:00.000Z",
    enabled: 1,
    status: "active",
  });

  await runDueSchedules(new Date("2099-06-11T03:00:00.000Z"));

  assert.deepEqual(notices(item.id).map((row) => row.dedupe_key), [
    `schedule:${profile.id}:${item.id}:2099-06-11T01:00:00.000Z:deadline:due`,
    `schedule:${profile.id}:${item.id}:2099-06-11T01:00:00.000Z:occurrence:early`,
  ]);
  scheduleRow = db.prepare("SELECT enabled, status FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...scheduleRow }, { enabled: 1, status: "active" });
});

test("complete recognizes the occurrence prefix in a full reminder key", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "explicit occurrence completion",
    calendar: "solar",
    date: "2099-06-20",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    deadlineOffsetMinutes: 120,
    reminders: [{ id: "due", minutesBefore: 0, target: "deadline" }],
  });
  const occurrenceAt = "2099-06-20T01:00:00.000Z";

  completeSchedule(profile, item.id, `${occurrenceAt}:deadline:due`);

  const completion = db.prepare(`
    SELECT occurrence_key, occurrence_at, status
    FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ?
  `).get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...completion }, {
    occurrence_key: occurrenceAt,
    occurrence_at: occurrenceAt,
    status: "completed",
  });
});

test("legacy occurrence notifications remain byte-for-byte unchanged while suppressing retries", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "legacy retry",
    calendar: "solar",
    date: "2099-07-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    reminders: [{ id: "legacy-id", minutesBefore: 0 }],
  });
  const legacyKey = `schedule:${profile.id}:${item.id}:2099-07-01T01:00:00.000Z:legacy-id`;
  db.prepare(`
    INSERT INTO profile_notifications(profile_id, source, title, body, created_at, dedupe_key)
    VALUES(?, 'schedule', 'old title', 'old queued body', ?, ?)
  `).run(profile.id, "2099-07-01T01:00:00.000Z", legacyKey);

  await runDueSchedules(new Date("2099-07-01T01:00:00.000Z"));

  const rows = notices(item.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "old title");
  assert.equal(rows[0].body, "old queued body");
  assert.equal(rows[0].dedupe_key, legacyKey);
});

test("retry after occurrence persistence failure reuses notification dedupe", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "post-publish retry",
    calendar: "solar",
    date: "2099-08-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    reminders: [{ id: "start", minutesBefore: 0 }],
  });
  db.exec(`
    CREATE TRIGGER fail_occurrence_write
    BEFORE INSERT ON schedule_occurrences
    WHEN NEW.schedule_id = '${item.id}'
    BEGIN
      SELECT RAISE(FAIL, 'forced occurrence persistence failure');
    END;
  `);
  await assert.rejects(
    () => runDueSchedules(new Date("2099-08-01T01:00:00.000Z")),
    /forced occurrence persistence failure/,
  );
  assert.equal(notices(item.id).length, 1);
  db.exec("DROP TRIGGER fail_occurrence_write");

  await runDueSchedules(new Date("2099-08-01T01:00:00.000Z"));

  assert.equal(notices(item.id).length, 1);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ?
  `).get(profile.id, item.id) as { count: number }).count, 1);
});

test("recurring schedules created inside the reminder window catch up the missed trigger", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  // 事件时间取"当前 +45 分钟"：提前 60 分钟的触发时刻已过，但目标时刻仍在未来 →
  // nextRunAt 应回拨到过去的触发时刻，由下一分钟 scheduler tick 立即补发。
  const nowUtc = DateTime.utc();
  const eventTime = nowUtc.setZone("Asia/Shanghai").plus({ minutes: 45 }).startOf("minute");
  const item = createSchedule(profile, {
    title: "window catch-up",
    calendar: "solar",
    date: eventTime.toFormat("yyyy-MM-dd"),
    time: eventTime.toFormat("HH:mm"),
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    reminders: [{ id: "early", minutesBefore: 60 }],
  });
  const expectedTrigger = eventTime.minus({ minutes: 60 }).toUTC();
  assert.ok(item.nextRunAt, "窗口内创建必须产生 nextRunAt");
  const nextRun = DateTime.fromISO(item.nextRunAt!, { zone: "utc" });
  assert.equal(nextRun.toISO(), expectedTrigger.toISO(), "nextRunAt 应为已过的触发时刻（当天提前 60 分钟）");
  assert.ok(nextRun.toMillis() <= DateTime.utc().toMillis(), "nextRunAt 必须落在过去以便下一 tick 补发");

  // 下一 tick 立即补发窗口内提醒（schedule_occurrences 去重保证不重复）。
  await runDueSchedules(new Date());
  const rows = notices(item.id);
  assert.equal(rows.length, 1);
  assert.match(String(rows[0].dedupe_key), /:occurrence:early$/);
});

test("a corrupt deadline_offset_minutes does not poison or disable the schedule", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "corrupt offset",
    calendar: "solar",
    date: "2099-05-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    deadlineOffsetMinutes: 120,
    reminders: [
      { id: "start", minutesBefore: 60, target: "occurrence" },
      { id: "due", minutesBefore: 30, target: "deadline" },
    ],
  });
  // 损坏 deadline_offset_minutes，并把 next_run_at 拨到 r-start 的触发时刻
  // （2099-05-01 08:00+08:00 = 00:00Z）。
  db.prepare(`
    UPDATE schedules SET deadline_offset_minutes = 'abc', next_run_at = ?
    WHERE profile_id = ? AND id = ?
  `).run("2099-05-01T00:00:00.000Z", profile.id, item.id);

  // 修复前：NaN 位移 → RRule.after(Invalid Date) 抛错 → 整个 tick 失败、next_run_at 不推进；
  // 修复后：deadline 提醒因无有效来源被干净跳过，occurrence 提醒正常触发，日程推进且保持 active。
  await runDueSchedules(new Date("2099-05-01T00:01:00.000Z"));
  assert.deepEqual(notices(item.id).map((row) => row.dedupe_key), [
    `schedule:${profile.id}:${item.id}:2099-05-01T01:00:00.000Z:occurrence:start`,
  ]);
  const scheduleRow = db.prepare(`
    SELECT next_run_at, enabled, status FROM schedules WHERE profile_id = ? AND id = ?
  `).get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...scheduleRow }, {
    next_run_at: "2099-05-02T00:00:00.000Z",
    enabled: 1,
    status: "active",
  });
});
