import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Lunar, Solar } from "lunar-javascript";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-test-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";

const { requireProfileContext } = await import("../src/core/profile.js");
const { createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule } = await import(
  "../src/modules/schedule/service.js",
);
const { publishGlobal, publishProfile, pullPending } = await import("../src/core/notifier.js");
const { getDatabase } = await import("../src/core/database.js");
const { runDueSchedules, acquireSchedulerLease, refreshSchedulerLease, releaseSchedulerLease } = await import(
  "../src/scheduler.js",
);

const db = getDatabase();

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Profile context is required and never falls back to default", () => {
  delete process.env.HERMES_PROFILE;
  assert.throws(() => requireProfileContext(), /HERMES_PROFILE/);
  process.env.HERMES_PROFILE = "profile-a";
  assert.equal(requireProfileContext().id, "profile-a");
});

test("schedule CRUD is isolated by Profile", () => {
  const a = requireProfileContext("profile-a");
  const created = createSchedule(a, {
    title: "A private anniversary",
    calendar: "solar",
    date: "2026-08-10",
    time: "09:30",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  assert.equal(listSchedules(a).length, 1);

  const b = requireProfileContext("profile-b");
  assert.equal(listSchedules(b).length, 0);
  assert.throws(() => getSchedule(b, created.id), /not found/i);
  assert.throws(() => updateSchedule(b, created.id, { title: "stolen" }), /not found/i);
  assert.throws(() => deleteSchedule(b, created.id), /not found/i);
  assert.equal(getSchedule(a, created.id).title, "A private anniversary");
});

test("global notices are visible once independently to each Profile", async () => {
  await publishGlobal("weather", "shared alert", "global:test:1");
  const a = pullPending(requireProfileContext("profile-a"));
  const b = pullPending(requireProfileContext("profile-b"));
  assert.equal(a.filter((n) => n.body === "shared alert").length, 1);
  assert.equal(b.filter((n) => n.body === "shared alert").length, 1);
  assert.equal(pullPending(requireProfileContext("profile-a")).some((n) => n.body === "shared alert"), false);
});

test("profile notices never cross the queue boundary", async () => {
  await publishProfile("profile-a", "schedule", "A only", "profile:test:a");
  const a = pullPending(requireProfileContext("profile-a"));
  const b = pullPending(requireProfileContext("profile-b"));
  assert.equal(a.some((n) => n.body === "A only"), true);
  assert.equal(b.some((n) => n.body === "A only"), false);
});

test("scheduler claims a singleton lease and emits only the target Profile notice", async () => {
  assert.equal(acquireSchedulerLease("test-owner"), true);
  assert.equal(acquireSchedulerLease("other-owner"), false);
  releaseSchedulerLease("test-owner");
  assert.equal(acquireSchedulerLease("other-owner"), true);
  releaseSchedulerLease("other-owner");

  const a = requireProfileContext("profile-a");
  const schedule = createSchedule(a, {
    title: "due item",
    calendar: "solar",
    date: "2020-01-01",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  await runDueSchedules(new Date("2026-08-02T00:00:00.000Z"));
  const aNotices = pullPending(a);
  const bNotices = pullPending(requireProfileContext("profile-b"));
  assert.equal(aNotices.some((n) => n.body.includes(schedule.title)), true);
  assert.equal(bNotices.some((n) => n.body.includes(schedule.title)), false);
});

test("a displaced scheduler owner cannot refresh or reacquire through the heartbeat path", () => {
  assert.equal(acquireSchedulerLease("stale-owner"), true);
  assert.equal(refreshSchedulerLease("stale-owner"), true);
  db.prepare("UPDATE scheduler_lease SET owner = ? WHERE name = ?").run("replacement-owner", "scheduler");
  assert.equal(refreshSchedulerLease("stale-owner"), false);
  db.prepare("DELETE FROM scheduler_lease WHERE name = ?").run("scheduler");
  assert.equal(refreshSchedulerLease("stale-owner"), false);
});

test("migration namespaces legacy shared schedule data instead of copying it", () => {
  const rows = db.prepare("SELECT profile_id FROM schedules WHERE title = ?").all("A private anniversary") as Array<{ profile_id: string }>;
  assert.deepEqual(rows.map((r) => r.profile_id), ["profile-a"]);
});

test("solar and lunar annual rules support normal and leap month policies", () => {
  const a = requireProfileContext("profile-a");
  const normal = createSchedule(a, {
    title: "lunar normal birthday",
    calendar: "lunar",
    lunarMonth: 6,
    lunarDay: 8,
    leapMonthPolicy: "normal",
    time: "08:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  const leap = createSchedule(a, {
    title: "lunar leap birthday",
    calendar: "lunar",
    lunarMonth: 6,
    lunarDay: 8,
    leapMonthPolicy: "leap",
    time: "08:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  assert.equal(normal.recurrence.calendar, "lunar");
  assert.equal(leap.recurrence.leapMonthPolicy, "leap");
  assert.ok(normal.nextRunAt);
  assert.ok(leap.nextRunAt);
});

test("Chinese lunar conversion preserves a known lunar new year date", () => {
  const solar = Lunar.fromYmd(2024, 1, 1).getSolar();
  assert.equal(solar.toYmd(), "2024-02-10");
  assert.equal(Solar.fromYmd(2024, 2, 10).getLunar().getMonth(), 1);
  assert.equal(Solar.fromYmd(2024, 2, 10).getLunar().getDay(), 1);
});

test("partial update preserves the calendar of a lunar schedule", () => {
  const a = requireProfileContext("profile-a");
  const created = createSchedule(a, {
    title: "农历纪念日",
    calendar: "lunar",
    lunarMonth: 1,
    lunarDay: 1,
    timezone: "Asia/Shanghai",
  });
  const updated = updateSchedule(a, created.id, { title: "改名后的农历纪念日" });
  assert.equal(updated.calendar, "lunar");
  assert.equal(updated.recurrence.calendar, "lunar");
  assert.equal(updated.title, "改名后的农历纪念日");
});
