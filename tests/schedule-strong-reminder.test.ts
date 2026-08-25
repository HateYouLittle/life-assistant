import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 测试隔离铁律：先设 DATA_DIR 再动态 import（静态 import 会读到真实 DB）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-strong-reminder-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "strong-reminder";
delete process.env.PROFILE_PUSH_ROUTES_JSON;

const { requireProfileContext } = await import("../src/core/profile.js");
const { getDatabase, resetDatabaseForTests } = await import("../src/core/database.js");
const {
  completeSchedule,
  createSchedule,
  deleteSchedule,
  getSchedule,
  updateSchedule,
} = await import("../src/modules/schedule/service.js");
const { runDueSchedules } = await import("../src/scheduler.js");
await import("../src/modules/schedule/index.js");
const { getModules } = await import("../src/core/registry.js");

const db = getDatabase();
const profile = requireProfileContext("strong-reminder");

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

function occurrenceKeys(scheduleId: string): string[] {
  return (db.prepare(`
    SELECT occurrence_key FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ?
    ORDER BY occurrence_key
  `).all(profile.id, scheduleId) as Array<{ occurrence_key: string }>).map((row) => row.occurrence_key);
}

function scheduleRow(scheduleId: string): Record<string, unknown> {
  return db.prepare(`
    SELECT next_run_at, enabled, status, version,
           reminder_interval_minutes, reminder_max_attempts
    FROM schedules WHERE profile_id = ? AND id = ?
  `).get(profile.id, scheduleId) as Record<string, unknown>;
}

test("unconfirmed occurrence resends at interval until max attempts then completes", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "resend until max",
    calendar: "solar",
    date: "2099-05-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 120,
    maxAttempts: 3,
  });

  // 正式提醒：发布后保持 active/enabled=1，next_run_at 推进到 now + interval。
  await runDueSchedules(new Date("2099-05-01T01:00:00.000Z"));
  assert.deepEqual(notices(item.id).map((row) => row.dedupe_key), [
    `schedule:${profile.id}:${item.id}:2099-05-01T01:00:00.000Z:occurrence:reminder-1`,
  ]);
  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: "2099-05-01T03:00:00.000Z",
    enabled: 1,
    status: "active",
    version: 2,
    reminder_interval_minutes: 120,
    reminder_max_attempts: 3,
  });

  // 第一轮重发：occurrence_key 带 :attempt-1 后缀。
  await runDueSchedules(new Date("2099-05-01T03:00:00.000Z"));
  assert.deepEqual(notices(item.id).map((row) => row.dedupe_key), [
    `schedule:${profile.id}:${item.id}:2099-05-01T01:00:00.000Z:occurrence:reminder-1`,
    `schedule:${profile.id}:${item.id}:2099-05-01T01:00:00.000Z:occurrence:reminder-1:attempt-1`,
  ]);
  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: "2099-05-01T05:00:00.000Z",
    enabled: 1,
    status: "active",
    version: 3,
    reminder_interval_minutes: 120,
    reminder_max_attempts: 3,
  });

  // 第二轮与第三轮（达上限）后收尾 completed。
  await runDueSchedules(new Date("2099-05-01T05:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-01T07:00:00.000Z"));
  assert.deepEqual(occurrenceKeys(item.id), [
    "2099-05-01T01:00:00.000Z:occurrence:reminder-1",
    "2099-05-01T01:00:00.000Z:occurrence:reminder-1:attempt-1",
    "2099-05-01T01:00:00.000Z:occurrence:reminder-1:attempt-2",
    "2099-05-01T01:00:00.000Z:occurrence:reminder-1:attempt-3",
  ]);
  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: null,
    enabled: 0,
    status: "completed",
    version: 5,
    reminder_interval_minutes: 120,
    reminder_max_attempts: 3,
  });

  // 达上限后不再重发。
  await runDueSchedules(new Date("2099-05-01T09:00:00.000Z"));
  assert.equal(notices(item.id).length, 4);
});

test("completing the todo stops the resend loop", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "complete stops",
    calendar: "solar",
    date: "2099-05-02",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-02T01:00:00.000Z"));
  assert.equal(notices(item.id).length, 1);

  completeSchedule(profile, item.id);
  await runDueSchedules(new Date("2099-05-02T02:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-02T03:00:00.000Z"));

  assert.equal(notices(item.id).length, 1);
  assert.deepEqual(occurrenceKeys(item.id), [
    "2099-05-02T01:00:00.000Z",
    "2099-05-02T01:00:00.000Z:occurrence:reminder-1",
  ]);
});

test("completing a recurring occurrence via attempt key stops its resends and keeps the next occurrence", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "recurring complete",
    calendar: "solar",
    date: "2099-05-06",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-06T01:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-06T02:00:00.000Z"));
  assert.equal(notices(item.id).length, 2);

  // 用 :attempt-1 后缀的 key 完成 occurrence，必须命中 completed 判定并终止重发。
  completeSchedule(profile, item.id, "2099-05-06T01:00:00.000Z:occurrence:reminder-1:attempt-1");
  await runDueSchedules(new Date("2099-05-06T03:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-06T04:00:00.000Z"));

  assert.equal(notices(item.id).length, 2);
  assert.deepEqual(occurrenceKeys(item.id), [
    "2099-05-06T01:00:00.000Z",
    "2099-05-06T01:00:00.000Z:occurrence:reminder-1",
    "2099-05-06T01:00:00.000Z:occurrence:reminder-1:attempt-1",
  ]);
  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: "2099-05-07T01:00:00.000Z",
    enabled: 1,
    status: "active",
    // completeSchedule 重算派生状态但不递增 version（既有语义）。
    version: 3,
    reminder_interval_minutes: 60,
    reminder_max_attempts: 3,
  });
});

test("deleting the todo stops the resend loop", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "delete stops",
    calendar: "solar",
    date: "2099-05-03",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-03T01:00:00.000Z"));
  assert.equal(notices(item.id).length, 1);

  deleteSchedule(profile, item.id);
  await runDueSchedules(new Date("2099-05-03T02:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-03T03:00:00.000Z"));

  assert.equal(notices(item.id).length, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ?
  `).get(profile.id, item.id) as { count: number }).count, 0);
});

test("strong reminder resends only the formal reminder, never early reminders", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "early + formal",
    calendar: "solar",
    date: "2099-05-04",
    time: "09:00",
    timezone: "Asia/Shanghai",
    reminders: [
      { id: "early", minutesBefore: 60 },
      { id: "due", minutesBefore: 0 },
    ],
    intervalMinutes: 60,
    maxAttempts: 2,
  });
  await runDueSchedules(new Date("2099-05-04T00:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-04T01:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-04T02:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-04T03:00:00.000Z"));

  assert.deepEqual(occurrenceKeys(item.id), [
    "2099-05-04T01:00:00.000Z:occurrence:due",
    "2099-05-04T01:00:00.000Z:occurrence:due:attempt-1",
    "2099-05-04T01:00:00.000Z:occurrence:due:attempt-2",
    "2099-05-04T01:00:00.000Z:occurrence:early",
  ]);
  // early 只发一次，重发只针对正式提醒 due。
  assert.equal(notices(item.id).length, 4);
});

test("strong reminder params persist, default and validate on create/update", () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const onlyInterval = createSchedule(profile, {
    title: "interval only",
    calendar: "solar",
    date: "2099-06-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 30,
  });
  assert.equal(onlyInterval.reminderIntervalMinutes, 30);
  assert.equal(onlyInterval.reminderMaxAttempts, 3);

  const onlyMax = createSchedule(profile, {
    title: "max only",
    calendar: "solar",
    date: "2099-06-02",
    time: "09:00",
    timezone: "Asia/Shanghai",
    maxAttempts: 5,
  });
  assert.equal(onlyMax.reminderIntervalMinutes, 120);
  assert.equal(onlyMax.reminderMaxAttempts, 5);

  const plain = createSchedule(profile, {
    title: "plain",
    calendar: "solar",
    date: "2099-06-03",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  assert.equal(plain.reminderIntervalMinutes, undefined);
  assert.equal(plain.reminderMaxAttempts, undefined);

  // 持久化回读 + update 透传。
  const loaded = getSchedule(profile, onlyInterval.id);
  assert.equal(loaded.reminderIntervalMinutes, 30);
  assert.equal(loaded.reminderMaxAttempts, 3);

  const updated = updateSchedule(profile, onlyInterval.id, { intervalMinutes: 90, maxAttempts: 7 });
  assert.equal(updated.reminderIntervalMinutes, 90);
  assert.equal(updated.reminderMaxAttempts, 7);
  assert.equal(getSchedule(profile, onlyInterval.id).reminderIntervalMinutes, 90);
  assert.equal(getSchedule(profile, onlyInterval.id).reminderMaxAttempts, 7);

  // 部分更新保留另一参数。
  const partial = updateSchedule(profile, onlyInterval.id, { maxAttempts: 2 });
  assert.equal(partial.reminderIntervalMinutes, 90);
  assert.equal(partial.reminderMaxAttempts, 2);

  // 边界校验：interval 1-10080、maxAttempts 1-99。
  assert.throws(
    () => createSchedule(profile, { title: "bad interval low", calendar: "solar", date: "2099-06-04", time: "09:00", timezone: "Asia/Shanghai", intervalMinutes: 0 }),
    /intervalMinutes/,
  );
  assert.throws(
    () => createSchedule(profile, { title: "bad interval high", calendar: "solar", date: "2099-06-04", time: "09:00", timezone: "Asia/Shanghai", intervalMinutes: 10081 }),
    /intervalMinutes/,
  );
  assert.throws(
    () => createSchedule(profile, { title: "bad attempts low", calendar: "solar", date: "2099-06-04", time: "09:00", timezone: "Asia/Shanghai", maxAttempts: 0 }),
    /maxAttempts/,
  );
  assert.throws(
    () => createSchedule(profile, { title: "bad attempts high", calendar: "solar", date: "2099-06-04", time: "09:00", timezone: "Asia/Shanghai", maxAttempts: 100 }),
    /maxAttempts/,
  );
  assert.throws(
    () => createSchedule(profile, { title: "bad attempts float", calendar: "solar", date: "2099-06-04", time: "09:00", timezone: "Asia/Shanghai", maxAttempts: 1.5 }),
    /maxAttempts/,
  );
});

test("MCP create/update schemas expose intervalMinutes/maxAttempts bounds", () => {
  const module = getModules().find((candidate) => candidate.name === "schedule");
  const create = module?.tools?.find((tool) => tool.name === "create");
  const update = module?.tools?.find((tool) => tool.name === "update");
  assert.ok(create);
  assert.ok(update);

  const createShape = create.schema as Record<string, { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } }>;
  assert.equal(createShape.intervalMinutes.parse(10080), 10080);
  assert.equal(createShape.maxAttempts.parse(99), 99);
  assert.equal(createShape.intervalMinutes.safeParse(10081).success, false);
  assert.equal(createShape.maxAttempts.safeParse(0).success, false);

  const updateShape = update.schema as Record<string, { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } }>;
  assert.equal(updateShape.intervalMinutes.parse(1), 1);
  assert.equal(updateShape.maxAttempts.safeParse(100).success, false);
});

test("resend writes ride the same version CAS and recover without duplicating attempts", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "cas recovery",
    calendar: "solar",
    date: "2099-05-05",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-05T01:00:00.000Z"));
  assert.equal(notices(item.id).length, 1);

  // 强制重发轮次的 next_run_at 写回失败（等价于版本 CAS 冲突：通知已发布、行已插入、推进被拒）。
  db.exec(`
    CREATE TRIGGER fail_resend_advance
    BEFORE UPDATE OF next_run_at ON schedules
    WHEN NEW.profile_id = '${profile.id}' AND NEW.id = '${item.id}' AND NEW.version = 3
    BEGIN
      SELECT RAISE(FAIL, 'forced resend advance failure');
    END;
  `);
  await assert.rejects(
    () => runDueSchedules(new Date("2099-05-05T02:00:00.000Z")),
    /forced resend advance failure/,
  );
  db.exec("DROP TRIGGER fail_resend_advance");

  // attempt-1 已落库；重跑同一 tick 不得重复 attempt-1，而是推进到 attempt-2。
  await runDueSchedules(new Date("2099-05-05T02:00:00.000Z"));
  assert.deepEqual(occurrenceKeys(item.id), [
    "2099-05-05T01:00:00.000Z:occurrence:reminder-1",
    "2099-05-05T01:00:00.000Z:occurrence:reminder-1:attempt-1",
    "2099-05-05T01:00:00.000Z:occurrence:reminder-1:attempt-2",
  ]);
  assert.equal(notices(item.id).length, 3);
  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: "2099-05-05T03:00:00.000Z",
    enabled: 1,
    status: "active",
    version: 3,
    reminder_interval_minutes: 60,
    reminder_max_attempts: 3,
  });

  // attempt-3 达上限后正常收尾 completed，不再重发。
  await runDueSchedules(new Date("2099-05-05T03:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-05T04:00:00.000Z"));
  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: null,
    enabled: 0,
    status: "completed",
    version: 4,
    reminder_interval_minutes: 60,
    reminder_max_attempts: 3,
  });
  assert.equal(notices(item.id).length, 4);
});
