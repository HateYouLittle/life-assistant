import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DateTime } from "luxon";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-deadline-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "deadline-profile";

const { requireProfileContext } = await import("../src/core/profile.js");
const { getModules } = await import("../src/core/registry.js");
await import("../src/modules/schedule/index.js");
const scheduleService = await import("../src/modules/schedule/service.js");
const { resetDatabaseForTests } = await import("../src/core/database.js");
type ValidDateTime = DateTime<true>;

function scheduleItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "timing-schedule",
    profileId: "deadline-profile",
    type: "todo" as const,
    title: "timing",
    priority: "normal" as const,
    status: "active" as const,
    calendar: "solar" as const,
    date: "2099-03-01",
    time: "09:00",
    allDay: false,
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "once" as const, interval: 1, calendar: "solar" as const },
    reminders: [{ id: "start", minutesBefore: 0, target: "occurrence" as const }],
    enabled: true,
    version: 1,
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test.after(() => {
  resetDatabaseForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("schedule tool contracts add deadline fields and reminder targets without breaking old inputs", () => {
  const module = getModules().find((candidate) => candidate.name === "schedule");
  const create = module?.tools?.find((tool) => tool.name === "create");
  const update = module?.tools?.find((tool) => tool.name === "update");
  assert.ok(create);
  assert.ok(update);

  const createShape = create.schema as Record<string, { parse(value: unknown): unknown }>;
  assert.equal(createShape.deadlineAt.parse("2026-08-08T10:00"), "2026-08-08T10:00");
  assert.equal(createShape.deadlineOffsetMinutes.parse(525600), 525600);
  assert.equal(createShape.clearDeadline.parse(true), true);
  assert.deepEqual(createShape.reminders.parse([{ minutesBefore: 0, target: "deadline" }]), [
    { minutesBefore: 0, target: "deadline" },
  ]);
  assert.deepEqual(createShape.reminders.parse([{ minutesBefore: 0 }]), [{ minutesBefore: 0 }]);

  const updateShape = update.schema as Record<string, { parse(value: unknown): unknown }>;
  assert.equal(updateShape.deadlineAt.parse("2026-08-08T10:00"), "2026-08-08T10:00");
  assert.equal(updateShape.deadlineOffsetMinutes.parse(0), 0);
  assert.equal(updateShape.clearDeadline.parse(true), true);
});

test("clearDeadline removes old deadline state before changing deadline modes", () => {
  const profile = requireProfileContext("deadline-profile");
  const once = scheduleService.createSchedule(profile, {
    title: "clear absolute deadline",
    calendar: "solar",
    date: "2099-02-01",
    time: "09:00",
    deadlineAt: "2099-02-01T10:00",
  });

  const cleared = scheduleService.updateSchedule(profile, once.id, { clearDeadline: true });
  assert.equal(cleared.deadlineAt, undefined);
  assert.equal(cleared.deadlineOffsetMinutes, undefined);
  assert.equal("clearDeadline" in cleared, false);

  const recurring = scheduleService.updateSchedule(profile, once.id, {
    recurrence: "daily",
    deadlineOffsetMinutes: 60,
  });
  assert.equal(recurring.deadlineAt, undefined);
  assert.equal(recurring.deadlineOffsetMinutes, 60);

  const ignoredOnCreate = scheduleService.createSchedule(profile, {
    title: "explicitly no deadline",
    calendar: "solar",
    date: "2099-02-02",
    deadlineAt: "2099-02-02T10:00",
    clearDeadline: true,
  });
  assert.equal(ignoredOnCreate.deadlineAt, undefined);
  assert.equal(ignoredOnCreate.deadlineOffsetMinutes, undefined);
  assert.equal("clearDeadline" in ignoredOnCreate, false);
});

test("clearDeadline rejects schedules whose reminders still target the deadline", () => {
  const profile = requireProfileContext("deadline-profile");
  const item = scheduleService.createSchedule(profile, {
    title: "deadline reminder must be adjusted first",
    calendar: "solar",
    date: "2099-02-03",
    deadlineAt: "2099-02-03T10:00",
    reminders: [{ id: "due", minutesBefore: 0, target: "deadline" }],
  });

  assert.throws(
    () => scheduleService.updateSchedule(profile, item.id, { clearDeadline: true }),
    /deadline target requires a deadline/,
  );
});

test("deadline validation rejects unsupported combinations before persistence", () => {
  const profile = requireProfileContext("deadline-profile");

  assert.throws(() => scheduleService.createSchedule(profile, {
    title: "once with offset",
    calendar: "solar",
    date: "2099-01-01",
    recurrence: "once",
    deadlineOffsetMinutes: 10,
  }), /once schedules require deadlineAt instead of deadlineOffsetMinutes/);

  assert.throws(() => scheduleService.createSchedule(profile, {
    title: "repeat with absolute deadline",
    calendar: "solar",
    date: "2099-01-01",
    recurrence: "daily",
    deadlineAt: "2099-01-01T10:00",
  }), /recurring schedules require deadlineOffsetMinutes instead of deadlineAt/);

  assert.throws(() => scheduleService.createSchedule(profile, {
    title: "bad offset",
    calendar: "solar",
    date: "2099-01-01",
    recurrence: "daily",
    deadlineOffsetMinutes: 525601,
  }), /deadlineOffsetMinutes must be an integer between 0 and 525600/);

  assert.throws(() => scheduleService.createSchedule(profile, {
    title: "missing deadline",
    calendar: "solar",
    date: "2099-01-01",
    reminders: [{ minutesBefore: 0, target: "deadline" }],
  }), /deadline target requires a deadline/);
});

test("absolute deadlines use the item timezone and cannot precede the occurrence", () => {
  const profile = requireProfileContext("deadline-profile");

  assert.throws(() => scheduleService.createSchedule(profile, {
    title: "invalid local deadline",
    calendar: "solar",
    date: "2099-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    deadlineAt: "not-a-time",
  }), /deadlineAt must be a valid ISO date-time in the schedule timezone/);

  assert.throws(() => scheduleService.createSchedule(profile, {
    title: "deadline before occurrence",
    calendar: "solar",
    date: "2099-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    deadlineAt: "2099-01-01T08:59",
  }), /deadline must not be earlier than occurrence/);

  const local = DateTime.fromISO("2099-01-01T09:00", { zone: "Asia/Shanghai" });
  assert.equal(local.toUTC().toISO(), "2099-01-01T01:00:00.000Z");
});

test("deadline and reminder timing helpers cover absolute, zero, and maximum offsets", () => {
  const deadlineForOccurrence = (scheduleService as Record<string, unknown>).deadlineForOccurrence as (
    item: ReturnType<typeof scheduleItem>, occurrence: ValidDateTime,
  ) => ValidDateTime | null;
  const reminderTiming = (scheduleService as Record<string, unknown>).reminderTiming as (
    item: ReturnType<typeof scheduleItem>,
    occurrence: ValidDateTime,
    reminder: { id: string; minutesBefore: number; target: "occurrence" | "deadline" },
  ) => { target: string; targetAt: ValidDateTime; triggerAt: ValidDateTime } | null;
  assert.equal(typeof deadlineForOccurrence, "function");
  assert.equal(typeof reminderTiming, "function");

  const occurrence = DateTime.fromISO("2099-03-01T01:00:00.000Z", { zone: "utc" }) as ValidDateTime;
  const once = scheduleItem({ deadlineAt: "2099-03-01T16:00:00.000Z" });
  assert.equal(deadlineForOccurrence(once, occurrence)?.toISO(), "2099-03-01T16:00:00.000Z");
  assert.deepEqual(
    Object.fromEntries(Object.entries(reminderTiming(once, occurrence, {
      id: "due",
      minutesBefore: 30,
      target: "deadline",
    }) ?? {}).map(([key, value]) => [key, DateTime.isDateTime(value) ? value.toISO() : value])),
    {
      target: "deadline",
      targetAt: "2099-03-01T16:00:00.000Z",
      triggerAt: "2099-03-01T15:30:00.000Z",
    },
  );

  const zero = scheduleItem({
    recurrence: { frequency: "daily", interval: 1, calendar: "solar" },
    deadlineOffsetMinutes: 0,
  });
  assert.equal(deadlineForOccurrence(zero, occurrence)?.toISO(), occurrence.toISO());

  const maximum = scheduleItem({
    recurrence: { frequency: "yearly", interval: 1, calendar: "solar" },
    deadlineOffsetMinutes: 525600,
  });
  assert.equal(deadlineForOccurrence(maximum, occurrence)?.toISO(), "2100-03-01T01:00:00.000Z");
});

test("calculateNextRun chooses the earliest target trigger, including a deadline after occurrence", () => {
  const calculateNextRun = scheduleService.calculateNextRun;
  const once = scheduleItem({
    deadlineAt: "2099-03-01T10:00:00.000Z",
    reminders: [
      { id: "start", minutesBefore: 60, target: "occurrence" },
      { id: "due", minutesBefore: 30, target: "deadline" },
    ],
  });
  const afterOccurrence = DateTime.fromISO("2099-03-01T02:00:00.000Z", { zone: "utc" }) as ValidDateTime;
  assert.equal(calculateNextRun(once, afterOccurrence, true)?.toISO(), "2099-03-01T09:30:00.000Z");
  assert.equal(
    calculateNextRun(once, DateTime.fromISO("2099-03-01T09:31:00.000Z", { zone: "utc" }) as ValidDateTime, true),
    null,
  );

  const repeating = scheduleItem({
    date: "2099-03-01",
    recurrence: { frequency: "daily", interval: 1, calendar: "solar" },
    deadlineOffsetMinutes: 120,
    reminders: [
      { id: "start", minutesBefore: 60, target: "occurrence" },
      { id: "due", minutesBefore: 30, target: "deadline" },
    ],
  });
  assert.equal(calculateNextRun(repeating, afterOccurrence, true)?.toISO(), "2099-03-01T02:30:00.000Z");
});

test("absolute deadline parsing handles local midnight and timezone date rollover", () => {
  const profile = requireProfileContext("deadline-profile");
  const midnight = scheduleService.createSchedule(profile, {
    title: "cross local midnight",
    calendar: "solar",
    date: "2099-04-01",
    time: "23:30",
    timezone: "America/Los_Angeles",
    deadlineAt: "2099-04-02T00:00",
    reminders: [{ minutesBefore: 0, target: "deadline" }],
  });
  assert.equal(midnight.deadlineAt, "2099-04-02T07:00:00.000Z");
});
