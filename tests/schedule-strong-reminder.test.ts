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
const { escapeLike, runDueSchedules } = await import("../src/scheduler.js");
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
    // P2-1：完成是内容级变更，递增 version 参与乐观锁，scheduler 旧快照不再覆盖 next_run_at。
    version: 4,
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

test("P1-1: completeSchedule during resend window completes the current occurrence, never the next one", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p1-1 resend window complete",
    calendar: "solar",
    date: "2099-05-20",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    reminders: [
      { id: "early", minutesBefore: 960 },
      { id: "due", minutesBefore: 0 },
    ],
    intervalMinutes: 240,
    maxAttempts: 3,
  });
  // T = 2099-05-20T01:00:00.000Z；提前提醒在 T-960（05-19T09:00）触发。
  await runDueSchedules(new Date("2099-05-19T09:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-20T01:00:00.000Z")); // 正式
  await runDueSchedules(new Date("2099-05-20T05:00:00.000Z")); // attempt-1
  // 现在 next_run_at = T+480（05-20T09:00），恰好等于下一 occurrence T' 的提前提醒
  // 触发时刻（T'-960 = T+480）：derived 会把 occurrence 解析到 T' —— 正是误标场景。
  assert.equal(scheduleRow(item.id).next_run_at, "2099-05-20T09:00:00.000Z");

  // 无 key 完成：必须解析到当前进行中的 occurrence T（2099-05-20T01:00）。
  completeSchedule(profile, item.id);
  const keys = occurrenceKeys(item.id);
  assert.equal(keys.includes("2099-05-20T01:00:00.000Z"), true);
  assert.equal(keys.includes("2099-05-21T01:00:00.000Z"), false);

  // T' 的提前与正式提醒仍正常触发（未被 occurrenceCompleted 静默跳过）。
  await runDueSchedules(new Date("2099-05-20T09:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-21T01:00:00.000Z"));
  assert.equal(occurrenceKeys(item.id).includes("2099-05-21T01:00:00.000Z:occurrence:early"), true);
  assert.equal(occurrenceKeys(item.id).includes("2099-05-21T01:00:00.000Z:occurrence:due"), true);
  // 当前 occurrence 的重发已停止：不再出现 attempt-2/3。
  assert.equal(occurrenceKeys(item.id).some((key) => key.includes("attempt-2") || key.includes("attempt-3")), false);
});

test("P1-1: plain early reminder completion still resolves to the correct occurrence (regression guard)", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p1-1 early only",
    calendar: "solar",
    date: "2099-05-25",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    reminders: [{ id: "early", minutesBefore: 960 }],
  });
  // next_run_at 就是提前提醒触发时刻（T-960 = 05-24T09:00）。
  assert.equal(item.nextRunAt, "2099-05-24T09:00:00.000Z");
  completeSchedule(profile, item.id);
  const keys = occurrenceKeys(item.id);
  // 完成的必须是 T（2099-05-25T01:00），不是 T-960 或下一 occurrence。
  assert.equal(keys.includes("2099-05-25T01:00:00.000Z"), true);
  assert.equal(keys.includes("2099-05-24T09:00:00.000Z"), false);
  assert.equal(keys.includes("2099-05-26T01:00:00.000Z"), false);
  // 完成的 T 不再发任何提醒。
  await runDueSchedules(new Date("2099-05-24T09:00:00.000Z"));
  assert.equal(notices(item.id).length, 0);
});

test("P2-1: concurrent completion bumps version so the scheduler cannot overwrite next_run_at", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-1 concurrent complete",
    calendar: "solar",
    date: "2099-05-09",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-09T01:00:00.000Z")); // 正式提醒，version 2
  assert.equal((scheduleRow(item.id).version as number), 2);

  // 模拟 completeSchedule 恰在 attempt-1 落库瞬间并发完成：completed 行 + version 递增
  // （对应 P2-1 修复后的真实 completeSchedule 行为）。
  db.exec(`
    CREATE TRIGGER complete_during_resend
    AFTER INSERT ON schedule_occurrences
    WHEN NEW.profile_id = '${profile.id}' AND NEW.schedule_id = '${item.id}'
      AND NEW.occurrence_key LIKE '%:occurrence:reminder-1:attempt-1'
    BEGIN
      INSERT INTO schedule_occurrences(profile_id, schedule_id, occurrence_key, occurrence_at, status)
      VALUES (NEW.profile_id, NEW.schedule_id, NEW.occurrence_at, NEW.occurrence_at, 'completed');
      UPDATE schedules SET status = 'completed', enabled = 0, next_run_at = NULL,
        version = version + 1, updated_at = NEW.occurrence_at
      WHERE profile_id = NEW.profile_id AND id = NEW.schedule_id;
    END;
  `);
  await runDueSchedules(new Date("2099-05-09T02:00:00.000Z"));
  db.exec("DROP TRIGGER complete_during_resend");

  // 完成者的终态不被 scheduler 的旧 version CAS 覆盖回重发时刻。
  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: null,
    enabled: 0,
    status: "completed",
    version: 3,
    reminder_interval_minutes: 60,
    reminder_max_attempts: 3,
  });
  // 之后不再有任何重发。
  await runDueSchedules(new Date("2099-05-09T03:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-09T04:00:00.000Z"));
  assert.equal(occurrenceKeys(item.id).length, 3); // completed T + formal + attempt-1
  assert.equal(notices(item.id).length, 2);
});

test("P2-3: clearStrongReminder turns off resends and stays off on later updates", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-3 clear strong",
    calendar: "solar",
    date: "2099-06-05",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-06-05T01:00:00.000Z"));
  await runDueSchedules(new Date("2099-06-05T02:00:00.000Z")); // attempt-1
  assert.equal(occurrenceKeys(item.id).some((key) => key.includes("attempt-1")), true);

  const cleared = updateSchedule(profile, item.id, { clearStrongReminder: true });
  assert.equal(cleared.reminderIntervalMinutes, undefined);
  assert.equal(cleared.reminderMaxAttempts, undefined);
  const row = scheduleRow(item.id);
  assert.equal(row.reminder_interval_minutes, null);
  assert.equal(row.reminder_max_attempts, null);

  // 关闭后不再重发：attempt-2 永不出现，下一 occurrence 正常触发。
  await runDueSchedules(new Date("2099-06-05T03:00:00.000Z"));
  await runDueSchedules(new Date("2099-06-06T01:00:00.000Z"));
  const keys = occurrenceKeys(item.id);
  assert.equal(keys.some((key) => key.includes("attempt-2")), false);
  assert.equal(keys.includes("2099-06-06T01:00:00.000Z:occurrence:reminder-1"), true);

  // 后续更新其他字段不重新开启强提醒。
  const renamed = updateSchedule(profile, item.id, { title: "renamed" });
  assert.equal(renamed.reminderIntervalMinutes, undefined);
  assert.equal(scheduleRow(item.id).reminder_interval_minutes, null);
});

test("P2-4: intervalMinutes >= recurrence interval never resends and the next occurrence takes over", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  let item;
  try {
    item = createSchedule(profile, {
      title: "p2-4 interval too large",
      calendar: "solar",
      date: "2099-05-30",
      time: "09:00",
      timezone: "Asia/Shanghai",
      recurrence: "daily",
      intervalMinutes: 1440,
      maxAttempts: 3,
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.some((message) => message.includes("intervalMinutes=1440") && message.includes("recurrence interval 1440min")), true);

  await runDueSchedules(new Date("2099-05-30T01:00:00.000Z")); // 正式 T
  await runDueSchedules(new Date("2099-05-31T01:00:00.000Z")); // 下一 occurrence 接管
  await runDueSchedules(new Date("2099-06-01T01:00:00.000Z"));
  assert.deepEqual(occurrenceKeys(item.id), [
    "2099-05-30T01:00:00.000Z:occurrence:reminder-1",
    "2099-05-31T01:00:00.000Z:occurrence:reminder-1",
    "2099-06-01T01:00:00.000Z:occurrence:reminder-1",
  ]);
  assert.equal(notices(item.id).length, 3);
});

test("P2-5: deleting during publish does not break the tick and cancels the orphaned notification", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const victim = createSchedule(profile, {
    title: "p2-5 victim",
    calendar: "solar",
    date: "2099-06-10",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  const survivor = createSchedule(profile, {
    title: "p2-5 survivor",
    calendar: "solar",
    date: "2099-06-10",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-06-10T01:00:00.000Z"));
  assert.equal(notices(victim.id).length, 1);
  assert.equal(notices(survivor.id).length, 1);

  // 模拟 deleteSchedule 恰在 publish 与 occurrence 落行之间执行：attempt-1 通知落库瞬间删掉日程。
  db.exec(`
    CREATE TRIGGER delete_during_publish
    AFTER INSERT ON profile_notifications
    WHEN NEW.profile_id = '${profile.id}' AND NEW.dedupe_key LIKE 'schedule:${profile.id}:${victim.id}:%:attempt-%'
    BEGIN
      DELETE FROM schedules WHERE profile_id = NEW.profile_id AND id = '${victim.id}';
    END;
  `);
  // tick 不得抛错中断。
  await runDueSchedules(new Date("2099-06-10T02:00:00.000Z"));
  db.exec("DROP TRIGGER delete_during_publish");

  // 孤儿通知的投递全部被取消（不再 pending/fallback 投递）。
  // 竞争 tick 内发布的通知被回滚：无残留 attempt 通知行（删除前已发布的 01:00 正式通知
  // 在真实生产由 deleteSchedule 的 S1.2 清理，不属于本竞争窗口）。
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM profile_notifications WHERE profile_id = ? AND dedupe_key LIKE ?")
    .get(profile.id, `schedule:${profile.id}:${victim.id}:%:attempt-%`) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, victim.id) as { n: number }).n, 0);

  // 幸存日程不受影响：attempt-1 正常、后续 attempt 继续（tick 未被中断）。
  assert.equal(occurrenceKeys(survivor.id).some((key) => key.includes("attempt-1")), true);
  await runDueSchedules(new Date("2099-06-10T03:00:00.000Z"));
  assert.equal(occurrenceKeys(survivor.id).some((key) => key.includes("attempt-2")), true);
});

test("P2-6: escapeLike escapes LIKE wildcards and wildcard reminder ids flow through occurrence matching", async () => {
  assert.equal(escapeLike("100%_of\\x"), "100\\%\\_of\\\\x");
  assert.equal(escapeLike("plain-id"), "plain-id");

  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-6 wildcard ids",
    calendar: "solar",
    date: "2099-06-20",
    time: "09:00",
    timezone: "Asia/Shanghai",
    reminders: [
      { id: "due%_x", minutesBefore: 0 },
      { id: "early\\y", minutesBefore: 60 },
    ],
    intervalMinutes: 60,
    maxAttempts: 2,
  });
  await runDueSchedules(new Date("2099-06-20T00:00:00.000Z")); // early\y（T-60）
  await runDueSchedules(new Date("2099-06-20T01:00:00.000Z")); // due%_x（正式）
  await runDueSchedules(new Date("2099-06-20T02:00:00.000Z")); // attempt-1
  await runDueSchedules(new Date("2099-06-20T03:00:00.000Z")); // attempt-2（达上限）
  assert.deepEqual(occurrenceKeys(item.id), [
    "2099-06-20T01:00:00.000Z:occurrence:due%_x",
    "2099-06-20T01:00:00.000Z:occurrence:due%_x:attempt-1",
    "2099-06-20T01:00:00.000Z:occurrence:due%_x:attempt-2",
    "2099-06-20T01:00:00.000Z:occurrence:early\\y",
  ]);
  assert.equal(notices(item.id).length, 4);
});

test("P2-6: reminder ids containing ':' are rejected on write paths", () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  assert.throws(
    () => createSchedule(profile, {
      title: "bad id",
      calendar: "solar",
      date: "2099-06-21",
      time: "09:00",
      timezone: "Asia/Shanghai",
      reminders: [{ id: "due:attempt-1", minutesBefore: 0 }],
    }),
    /must not contain ':'/,
  );
  const module = getModules().find((candidate) => candidate.name === "schedule");
  const create = module?.tools?.find((tool) => tool.name === "create");
  const update = module?.tools?.find((tool) => tool.name === "update");
  assert.ok(create);
  assert.ok(update);
  const createShape = create.schema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
  const updateShape = update.schema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
  assert.equal(createShape.reminders.safeParse([{ id: "a:b", minutesBefore: 0 }]).success, false);
  assert.equal(updateShape.reminders.safeParse([{ id: "a:b", minutesBefore: 0 }]).success, false);
  assert.equal(createShape.reminders.safeParse([{ id: "100%_of", minutesBefore: 0 }]).success, true);
});

test("P3-3: strong reminder requires an occurrence formal reminder (target=occurrence, minutesBefore=0)", () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  // 仅提前提醒 → 拒绝。
  assert.throws(
    () => createSchedule(profile, {
      title: "no formal",
      calendar: "solar",
      date: "2099-06-22",
      time: "09:00",
      timezone: "Asia/Shanghai",
      reminders: [{ id: "early", minutesBefore: 30 }],
      intervalMinutes: 60,
    }),
    /强提醒需要一条 occurrence 正式提醒/,
  );
  // 仅 deadline 提醒 → 拒绝。
  assert.throws(
    () => createSchedule(profile, {
      title: "deadline only",
      calendar: "solar",
      date: "2099-06-23",
      time: "09:00",
      timezone: "Asia/Shanghai",
      deadlineAt: "2099-06-23T10:00",
      reminders: [{ id: "due", minutesBefore: 0, target: "deadline" }],
      maxAttempts: 3,
    }),
    /强提醒需要一条 occurrence 正式提醒/,
  );
  // 默认 reminders（reminder-1 minutesBefore=0）天然满足。
  const ok = createSchedule(profile, {
    title: "default formal ok",
    calendar: "solar",
    date: "2099-06-24",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
  });
  assert.equal(ok.reminderMaxAttempts, 3);
  // update 开启强提醒且 reminders 无正式提醒 → 拒绝。
  const plain = createSchedule(profile, {
    title: "plain early",
    calendar: "solar",
    date: "2099-06-25",
    time: "09:00",
    timezone: "Asia/Shanghai",
    reminders: [{ id: "early", minutesBefore: 30 }],
  });
  assert.throws(
    () => updateSchedule(profile, plain.id, { intervalMinutes: 60 }),
    /强提醒需要一条 occurrence 正式提醒/,
  );
  // update 替换 reminders 移除正式提醒（强提醒保持开启）→ 拒绝。
  const strong = createSchedule(profile, {
    title: "strong default",
    calendar: "solar",
    date: "2099-06-26",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
  });
  assert.throws(
    () => updateSchedule(profile, strong.id, { reminders: [{ id: "only-early", minutesBefore: 30 }] }),
    /强提醒需要一条 occurrence 正式提醒/,
  );
  // 同时关闭强提醒则允许。
  const cleared = updateSchedule(profile, strong.id, {
    clearStrongReminder: true,
    reminders: [{ id: "only-early", minutesBefore: 30 }],
  });
  assert.equal(cleared.reminderIntervalMinutes, undefined);
});

test("MCP update schema exposes clearStrongReminder", () => {
  const module = getModules().find((candidate) => candidate.name === "schedule");
  const update = module?.tools?.find((tool) => tool.name === "update");
  assert.ok(update);
  const updateShape = update.schema as Record<string, { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } }>;
  assert.equal(updateShape.clearStrongReminder.parse(true), true);
  assert.equal(updateShape.clearStrongReminder.safeParse("yes").success, false);
});
