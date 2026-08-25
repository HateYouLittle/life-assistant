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

test("P2-1: real completeSchedule during the resend window bumps version and terminates resends (red→green guard)", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-1 real complete",
    calendar: "solar",
    date: "2099-05-09",
    time: "09:00",
    timezone: "Asia/Shanghai",
    // daily + count:1：T 是唯一 occurrence，完成 T 后无下一 occurrence → 终态
    // next_run_at=NULL/status=completed/enabled=0，便于断言「后跑 tick 不被覆盖」。
    recurrence: { frequency: "daily", count: 1 },
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-09T01:00:00.000Z")); // 正式提醒，version 2
  await runDueSchedules(new Date("2099-05-09T02:00:00.000Z")); // attempt-1，version 3
  assert.equal((scheduleRow(item.id).version as number), 3);

  // 真实调用 completeSchedule（走 service 真实代码，不用 SQL trigger 模拟）：以 attempt-1
  // 的 occurrence key 完成当前 occurrence，version 由 completeSchedule 自身的 P2-1 递增
  // 逻辑写回（还原/注释掉 service.ts 里的 `normalizeVersion(rawVersion) + 1` 递增 →
  // 下方 version=4 断言失败，保证红→绿有效）。
  completeSchedule(
    profile,
    item.id,
    "2099-05-09T01:00:00.000Z:occurrence:reminder-1:attempt-1",
    new Date("2099-05-09T02:05:00.000Z"),
  );
  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: null,
    enabled: 0,
    status: "completed",
    version: 4, // completeSchedule 的 P2-1 version 递增（3 → 4）
    reminder_interval_minutes: 60,
    reminder_max_attempts: 3,
  });

  // 后续 scheduler tick 不再产生重发，也不把 next_run_at 覆盖回重发时刻。
  await runDueSchedules(new Date("2099-05-09T03:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-09T04:00:00.000Z"));
  assert.equal(scheduleRow(item.id).next_run_at, null);
  assert.deepEqual(occurrenceKeys(item.id), [
    "2099-05-09T01:00:00.000Z",
    "2099-05-09T01:00:00.000Z:occurrence:reminder-1",
    "2099-05-09T01:00:00.000Z:occurrence:reminder-1:attempt-1",
  ]);
  assert.equal(notices(item.id).length, 2);
});

test("P2-1: scheduler stale snapshot never overwrites next_run_at after a concurrent completion (terminal-state simulation)", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-1 stale skip",
    calendar: "solar",
    date: "2099-05-10",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-10T01:00:00.000Z")); // 正式提醒，version 2
  assert.equal((scheduleRow(item.id).version as number), 2);

  // 注意：此用例锁定的是 scheduler 的 stale-skip（不回写 next_run_at），不是
  // completeSchedule 的 version 递增（那是上面真实路径用例的事）。trigger 模拟的是
  // 「并发完成已经发生、version 已递增」的终态：completed 行 + status/enabled/next_run_at
  // 终态 + version 递增，对应 completeSchedule 恰在 attempt-1 落库瞬间（publishNotification
  // 的 await 点之后）完成后的数据库形态。version 递增本身由 trigger 写入，故不作为本用例
  // 对 completeSchedule 递增逻辑的锁定依据。
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
  // scheduler 在本 tick 开头已持 version 2 快照（fresh.version=2）；若 stale-skip 失效、
  // 它把 next_run_at 写回 03:00/active/enabled=1，下方终态断言即失败。
  await runDueSchedules(new Date("2099-05-10T02:00:00.000Z"));
  db.exec("DROP TRIGGER complete_during_resend");

  assert.deepEqual({ ...scheduleRow(item.id) }, {
    next_run_at: null,
    enabled: 0,
    status: "completed",
    version: 3, // trigger 写入的终态版本；scheduler 的旧版本 CAS（WHERE version IS 2）未命中
    reminder_interval_minutes: 60,
    reminder_max_attempts: 3,
  });
  // 之后不再有任何重发（stale 写回若发生，03:00 会再发 attempt-2）。
  await runDueSchedules(new Date("2099-05-10T03:00:00.000Z"));
  await runDueSchedules(new Date("2099-05-10T04:00:00.000Z"));
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

test("P3-1: interval warning only fires when strong-reminder fields are explicitly involved", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    // (a) create 显式传 intervalMinutes：daily 触发间隔 1440，2400 >= 1440 → 警告出现。
    const item = createSchedule(profile, {
      title: "p3-1 explicit create",
      calendar: "solar",
      date: "2099-07-05",
      time: "09:00",
      timezone: "Asia/Shanghai",
      recurrence: "daily",
      intervalMinutes: 2400,
      maxAttempts: 3,
    });
    assert.equal(warnings.some((message) => message.includes("intervalMinutes=2400") && message.includes("recurrence interval 1440min")), true);

    // (b) 仅改 title：merged 输入恒带当前 intervalMinutes=2400，但本次未显式涉及强提醒
    // 字段 → 不刷该警告（修复前每次 update 都会刷）。
    warnings.length = 0;
    updateSchedule(profile, item.id, { title: "p3-1 renamed" });
    assert.equal(warnings.some((message) => message.includes("recurrence interval")), false);

    // (c) update 显式改 intervalMinutes 为 >=1440 → 警告出现。
    warnings.length = 0;
    updateSchedule(profile, item.id, { intervalMinutes: 1440 });
    assert.equal(warnings.some((message) => message.includes("intervalMinutes=1440") && message.includes("recurrence interval 1440min")), true);

    // 传 clearStrongReminder（即使同时显式传大 interval）也不刷警告。
    warnings.length = 0;
    const cleared = updateSchedule(profile, item.id, { clearStrongReminder: true, intervalMinutes: 5000 });
    assert.equal(warnings.some((message) => message.includes("recurrence interval")), false);
    assert.equal(cleared.reminderIntervalMinutes, undefined);
  } finally {
    console.warn = originalWarn;
  }
});

test("P3-2: byWeekday makes the daily/weekly interval warning unavailable", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    // daily + byWeekday（如 [MO..FR]，实际 gap 1-3 天）：间隔无法廉价确定，即使
    // intervalMinutes >= 1440 也不输出提示性警告。
    createSchedule(profile, {
      title: "p3-2 byweekday",
      calendar: "solar",
      date: "2099-07-06",
      time: "09:00",
      timezone: "Asia/Shanghai",
      recurrence: { frequency: "daily", byWeekday: ["MO", "TU", "WE", "TH", "FR"] },
      intervalMinutes: 1440,
      maxAttempts: 3,
    });
    assert.equal(warnings.some((message) => message.includes("recurrence interval")), false);

    // 同配置无 byWeekday 的 daily 仍警告。
    createSchedule(profile, {
      title: "p3-2 plain daily",
      calendar: "solar",
      date: "2099-07-07",
      time: "09:00",
      timezone: "Asia/Shanghai",
      recurrence: "daily",
      intervalMinutes: 1440,
      maxAttempts: 3,
    });
    assert.equal(warnings.some((message) => message.includes("intervalMinutes=1440") && message.includes("recurrence interval 1440min")), true);
  } finally {
    console.warn = originalWarn;
  }
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

test("P2-7: non-timeline update inside the resend window keeps the resend schedule and remaining attempts", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-7 rename during resend",
    calendar: "solar",
    date: "2099-05-15",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-15T01:00:00.000Z")); // 正式提醒
  await runDueSchedules(new Date("2099-05-15T02:00:00.000Z")); // attempt-1 → next_run_at = 03:00
  assert.equal(scheduleRow(item.id).next_run_at, "2099-05-15T03:00:00.000Z");

  // 重发窗口内仅改 title：不重算到下一 occurrence，next_run_at 保持重发时刻 03:00，
  // 剩余 attempts 不丢（还原 P2-7 保留分支 → 下面 next_run_at/attempt-2 断言失败）。
  const renamed = updateSchedule(profile, item.id, { title: "p2-7 renamed" }, new Date("2099-05-15T02:05:00.000Z"));
  assert.equal(renamed.title, "p2-7 renamed");
  assert.equal(scheduleRow(item.id).next_run_at, "2099-05-15T03:00:00.000Z");

  // 下一轮 attempt-2 照常触发。
  await runDueSchedules(new Date("2099-05-15T03:00:00.000Z"));
  assert.equal(occurrenceKeys(item.id).some((key) => key.includes("attempt-2")), true);
});

test("P2-7: timeline-affecting update inside the resend window recomputes next_run_at (unchanged behavior)", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-7 timeline change",
    calendar: "solar",
    date: "2099-05-16",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-16T01:00:00.000Z")); // 正式提醒
  await runDueSchedules(new Date("2099-05-16T02:00:00.000Z")); // attempt-1 → next_run_at = 03:00
  assert.equal(scheduleRow(item.id).next_run_at, "2099-05-16T03:00:00.000Z");

  // 改 reminders（时间线字段）→ 照常重算，不再保留 03:00（与现状一致）。
  updateSchedule(profile, item.id, {
    reminders: [{ id: "early", minutesBefore: 30 }, { id: "due", minutesBefore: 0 }],
  }, new Date("2099-05-16T02:05:00.000Z"));
  assert.notEqual(scheduleRow(item.id).next_run_at, "2099-05-16T03:00:00.000Z");
});

test("P2-7: lunar date change inside the resend window recomputes next_run_at (title-only keeps it)", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  // 农历 5/15 → 公历 2099-07-03（09:00 Asia/Shanghai = 01:00Z）；at 钉住创建时钟，
  // 让首个 occurrence 落在 2099 而非 2098，与其余 P2-7 用例同一时间线。
  const item = createSchedule(profile, {
    title: "p2-7 lunar change",
    calendar: "lunar",
    lunarMonth: 5,
    lunarDay: 15,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "yearly" },
    intervalMinutes: 60,
    maxAttempts: 3,
  }, new Date("2099-07-01T00:00:00.000Z"));
  await runDueSchedules(new Date("2099-07-03T01:00:00.000Z")); // 正式提醒
  await runDueSchedules(new Date("2099-07-03T02:00:00.000Z")); // attempt-1 → next_run_at = 03:00
  assert.equal(scheduleRow(item.id).next_run_at, "2099-07-03T03:00:00.000Z");

  // 对照：重发窗口内只改 title → 保留重发时刻 03:00。
  updateSchedule(profile, item.id, { title: "p2-7 lunar renamed" }, new Date("2099-07-03T02:05:00.000Z"));
  assert.equal(scheduleRow(item.id).next_run_at, "2099-07-03T03:00:00.000Z");

  // 改 lunarMonth（时间线字段）→ 按新时间线重算：农历 6/15 → 公历 2099-08-01，
  // 不再保留旧重发时刻 03:00（还原 timelineKeys 缺 lunarMonth → 保留 03:00，下面断言失败）。
  const lunarChanged = updateSchedule(profile, item.id, { lunarMonth: 6 }, new Date("2099-07-03T02:05:00.000Z"));
  assert.equal(lunarChanged.lunarMonth, 6);
  assert.equal(scheduleRow(item.id).next_run_at, "2099-08-01T01:00:00.000Z");
  assert.notEqual(scheduleRow(item.id).next_run_at, "2099-07-03T03:00:00.000Z");
});

test("P2-7: update outside the resend window recomputes as before", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-7 outside window",
    calendar: "solar",
    date: "2099-05-18",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  // 正式提醒尚未发布：next_run_at = 发生时刻 05-18T01:00，不在重发窗口。
  assert.equal(item.nextRunAt, "2099-05-18T01:00:00.000Z");
  const renamed = updateSchedule(profile, item.id, { title: "renamed-outside" }, new Date("2099-05-17T00:00:00.000Z"));
  // 无 notified occurrence → 保留分支不命中，照常重算到下一 occurrence 触发。
  assert.equal(renamed.nextRunAt, "2099-05-18T01:00:00.000Z");
});

test("P2-7: clearStrongReminder inside the resend window recomputes to the real trigger and stops resends", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-7 clear in window",
    calendar: "solar",
    date: "2099-05-19",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-19T01:00:00.000Z")); // 正式提醒
  await runDueSchedules(new Date("2099-05-19T02:00:00.000Z")); // attempt-1 → next_run_at = 03:00
  assert.equal(scheduleRow(item.id).next_run_at, "2099-05-19T03:00:00.000Z");

  // 关闭强提醒：正常重算，next_run_at 回到真实触发语义（下一 occurrence 正式提醒）。
  const cleared = updateSchedule(profile, item.id, { clearStrongReminder: true }, new Date("2099-05-19T02:05:00.000Z"));
  assert.equal(cleared.reminderIntervalMinutes, undefined);
  assert.equal(cleared.reminderMaxAttempts, undefined);
  assert.equal(scheduleRow(item.id).next_run_at, "2099-05-20T01:00:00.000Z");

  // 不再重发 attempt-2；下一 occurrence 正式提醒照常。
  await runDueSchedules(new Date("2099-05-19T03:00:00.000Z"));
  assert.equal(occurrenceKeys(item.id).some((key) => key.includes("attempt-2")), false);
  await runDueSchedules(new Date("2099-05-20T01:00:00.000Z"));
  assert.equal(occurrenceKeys(item.id).includes("2099-05-20T01:00:00.000Z:occurrence:reminder-1"), true);
});

test("P2-8: completeSchedule conflict rolls back the completed row (error matches outcome, retry converges)", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p2-8 conflict rollback",
    calendar: "solar",
    date: "2099-05-21",
    time: "09:00",
    timezone: "Asia/Shanghai",
    // daily + count:1：走 recurring 分支的版本守卫 UPDATE（once 分支经 updateSchedule
    // 会重读版本，冲突路径不经过 completeSchedule 自身的守卫）。
    recurrence: { frequency: "daily", count: 1 },
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-05-21T01:00:00.000Z")); // 正式提醒
  await runDueSchedules(new Date("2099-05-21T02:00:00.000Z")); // attempt-1
  assert.equal((scheduleRow(item.id).version as number), 3);

  // 模拟并发：scheduler 在 completed 行落库瞬间抢先推进 version（AFTER INSERT trigger），
  // 使 completeSchedule 的版本守卫 UPDATE 失败——正是此前「completed 已落但报冲突」的误报窗口。
  db.exec(`
    CREATE TRIGGER complete_conflict_advance
    AFTER INSERT ON schedule_occurrences
    WHEN NEW.profile_id = '${profile.id}' AND NEW.schedule_id = '${item.id}' AND NEW.status = 'completed'
    BEGIN
      UPDATE schedules SET version = version + 1 WHERE profile_id = NEW.profile_id AND id = NEW.schedule_id;
    END;
  `);
  try {
    assert.throws(
      () => completeSchedule(
        profile,
        item.id,
        "2099-05-21T01:00:00.000Z:occurrence:reminder-1:attempt-1",
        new Date("2099-05-21T02:05:00.000Z"),
      ),
      /schedule update conflict/,
    );
  } finally {
    db.exec("DROP TRIGGER complete_conflict_advance");
  }

  // 事务整体回滚：completed 行未落库、version 未被推进（trigger 的推进一并回滚），
  // 报错与结果一致（还原 P2-8 事务 → completed 行残留、version=4，以下断言失败）。
  assert.equal(scheduleRow(item.id).version, 3);
  assert.equal(db.prepare(`
    SELECT 1 FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ? AND status = 'completed'
  `).get(profile.id, item.id), undefined);

  // 重试（无并发）按当前版本幂等收敛：completed 行落库，完成语义正常（version 3→4）。
  completeSchedule(
    profile,
    item.id,
    "2099-05-21T01:00:00.000Z:occurrence:reminder-1:attempt-1",
    new Date("2099-05-21T02:10:00.000Z"),
  );
  assert.equal(scheduleRow(item.id).version, 4);
  assert.notEqual(db.prepare(`
    SELECT 1 FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ? AND status = 'completed'
  `).get(profile.id, item.id), undefined);
});

test("P3-5: resend notifications carry the attempt round marker; formal reminders do not", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  const item = createSchedule(profile, {
    title: "p3-5 round marker",
    calendar: "solar",
    date: "2099-06-30",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 3,
  });
  await runDueSchedules(new Date("2099-06-30T01:00:00.000Z")); // 正式提醒
  await runDueSchedules(new Date("2099-06-30T02:00:00.000Z")); // attempt-1
  await runDueSchedules(new Date("2099-06-30T03:00:00.000Z")); // attempt-2
  const rows = notices(item.id);
  const byKey = new Map(rows.map((row) => [String(row.dedupe_key), row]));
  const formal = byKey.get(`schedule:${profile.id}:${item.id}:2099-06-30T01:00:00.000Z:occurrence:reminder-1`);
  const attempt1 = byKey.get(`schedule:${profile.id}:${item.id}:2099-06-30T01:00:00.000Z:occurrence:reminder-1:attempt-1`);
  const attempt2 = byKey.get(`schedule:${profile.id}:${item.id}:2099-06-30T01:00:00.000Z:occurrence:reminder-1:attempt-2`);
  assert.ok(formal, "正式提醒应存在");
  assert.ok(attempt1, "attempt-1 应存在");
  assert.ok(attempt2, "attempt-2 应存在");

  // 正式提醒：标题/正文均无轮次标记。
  assert.equal(String(formal.title), "待办 · 发生提醒：p3-5 round marker");
  assert.equal(String(formal.title).includes("第 1 次提醒"), false);

  // attempt-1/2：标题与正文首行均含轮次标记与总次数。
  assert.equal(String(attempt1.title), "待办 · 发生提醒：p3-5 round marker（第 1 次提醒，共 3 次）");
  assert.ok(String(attempt1.body).includes("第 1 次提醒，共 3 次"));
  assert.equal(String(attempt2.title), "待办 · 发生提醒：p3-5 round marker（第 2 次提醒，共 3 次）");
  assert.ok(String(attempt2.body).includes("第 2 次提醒，共 3 次"));

  // dedupe/去重不受影响：重复 tick 不重复发布，通知总数不变。
  await runDueSchedules(new Date("2099-06-30T02:00:00.000Z"));
  await runDueSchedules(new Date("2099-06-30T03:00:00.000Z"));
  assert.equal(notices(item.id).length, 3);
});
