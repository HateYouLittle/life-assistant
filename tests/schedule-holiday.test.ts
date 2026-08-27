import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DateTime } from "luxon";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-schedule-holiday-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "schedule-holiday";
delete process.env.PROFILE_PUSH_ROUTES_JSON;

const { getDatabase, resetDatabaseForTests } = await import("../src/core/database.js");
const { requireProfileContext } = await import("../src/core/profile.js");
const {
  completeSchedule,
  createSchedule,
  findOccurrence,
  getSchedule,
  hydrateRow,
  reconcileHolidaySchedules,
  updateSchedule,
} = await import("../src/modules/schedule/service.js");
const { ingestHolidayYear } = await import("../src/modules/holiday/calendar.js");
const { parseDataset } = await import("../src/modules/holiday/provider.js");
const { runDueSchedules } = await import("../src/modules/schedule/tick.js");

const db = getDatabase();
const profile = requireProfileContext("schedule-holiday");

// P3 固定年份注入：下面 T4 系列用例的锚点固定为 2026。create/update/complete/reconcile
// 均接受可注入时钟，测试统一钉在 2026 年中：断言语义不随真实年份漂移，也没有逐年
// 推进常量的人工负担（2027 年及以后运行本文件依然全绿）。
const FIXED_TEST_YEAR = 2026;
const FIXED_TEST_AT = () => new Date(`${FIXED_TEST_YEAR}-07-01T00:00:00.000Z`);

test.after(() => {
  resetDatabaseForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function syntheticRaw(year: number): Record<string, unknown> {
  const groups: Array<[string, [number, number], number]> = [
    ["元旦", [1, 1], 3],
    ["春节", [2, 1], 8],
    ["清明节", [4, 4], 3],
    ["劳动节", [5, 1], 5],
    ["端午节", [6, 1], 3],
    ["中秋节", [9, 15], 3],
    ["国庆节", [10, 1], 7],
  ];
  const days: Array<Record<string, unknown>> = [];
  for (const [name, [month, day], length] of groups) {
    let cursor = DateTime.fromObject({ year, month, day }, { zone: "Asia/Shanghai" });
    for (let index = 0; index < length; index += 1) {
      days.push({ name, date: cursor.toFormat("yyyy-MM-dd"), isOffDay: true });
      cursor = cursor.plus({ days: 1 });
    }
  }
  return { year, papers: [`https://www.gov.cn/zhengce/${year}.htm`], days };
}

function ingestYear(year: number): void {
  ingestHolidayYear(parseDataset("holiday-cn", syntheticRaw(year)));
}

// 动态推算某一次运行后的「下一个工作日 09:00（Asia/Shanghai）」。
// 与 service 的 workday 推进语义一致：跳过周末与已摄入的法定假日。
// 绝不能写死绝对日期——运行日期一旦越过写死的值就会产生日期炸弹。
function nextWorkdayAfterIso(iso: string): string {
  const offDays = new Set(
    (db.prepare("SELECT date FROM cn_holiday_days WHERE year = ?").all(FIXED_TEST_YEAR) as Array<{ date: string }>)
      .map((row) => row.date),
  );
  let cursor = DateTime.fromISO(iso, { zone: "Asia/Shanghai" }).plus({ days: 1 });
  while (offDays.has(cursor.toFormat("yyyy-MM-dd")) || cursor.weekday >= 6) {
    cursor = cursor.plus({ days: 1 });
  }
  return cursor.startOf("day").set({ hour: 9 }).toUTC().toISO();
}

function clearYear(year: number): void {
  db.prepare("DELETE FROM cn_holiday_year_meta WHERE year = ?").run(year);
  db.prepare("DELETE FROM cn_holiday_days WHERE year = ?").run(year);
}

function atUtc(iso: string) {
  return DateTime.fromISO(iso, { zone: "utc" }) as DateTime<true>;
}

function createWorkday(overrides: Record<string, unknown> = {}) {
  return createSchedule(profile, {
    title: "法定工作日提醒",
    calendar: "solar",
    date: "2026-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
    ...overrides,
  });
}

function insertScheduleRow(id: string, recurrence: string, nextRunAt: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, note, priority, status, calendar, date,
      lunar_month, lunar_day, leap_month_policy, time, all_day, timezone, recurrence_json,
      reminders_json, deadline_at, deadline_offset_minutes, enabled, next_run_at, version,
      created_at, updated_at)
    VALUES(?, ?, 'todo', ?, NULL, 'normal', 'active', 'solar', '2026-01-01',
      NULL, NULL, NULL, '09:00', 0, 'Asia/Shanghai', ?,
      '[{"id":"reminder-1","minutesBefore":0,"target":"occurrence"}]',
      NULL, NULL, 1, ?, 1, ?, ?)
  `).run(profile.id, id, `manual ${id}`, recurrence, nextRunAt, now, now);
}

test("workday/holiday recurrence rejects unsupported calendar/timezone/rule options", () => {
  assert.throws(
    () => createSchedule(profile, {
      title: "lunar workday",
      calendar: "lunar",
      lunarMonth: 1,
      lunarDay: 1,
      timezone: "Asia/Shanghai",
      recurrence: "workday",
    }),
    /yearly recurrence|solar calendar/,
  );
  assert.throws(() => createWorkday({ timezone: "America/New_York" }), /timezone Asia\/Shanghai/);
  assert.throws(() => createWorkday({ recurrence: { frequency: "workday", interval: 2 } }), /does not support interval/);
  assert.throws(
    () => createWorkday({ recurrence: { frequency: "workday", byWeekday: ["MO"] } }),
    /does not support byWeekday\/byMonthDay/,
  );
});

test("S3: workday and ordinary RRule reject until dates that are not real calendar days", () => {
  const year = FIXED_TEST_YEAR;
  assert.throws(
    () => createSchedule(profile, {
      title: "bad workday until",
      calendar: "solar",
      date: `${year}-01-05`,
      time: "09:00",
      timezone: "Asia/Shanghai",
      recurrence: { frequency: "workday", until: "2026-02-30" },
    }),
    /until must be a valid calendar date/,
  );
  assert.throws(
    () => createSchedule(profile, {
      title: "bad daily until",
      calendar: "solar",
      date: `${year}-01-05`,
      time: "09:00",
      timezone: "Asia/Shanghai",
      recurrence: { frequency: "daily", until: "2026-02-30" },
    }),
    /until must be a valid calendar date/,
  );

  const item = createSchedule(profile, {
    title: "workday until update",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  });
  assert.throws(
    () => updateSchedule(profile, item.id, {
      recurrence: { frequency: "workday", until: "2026-02-30" },
    }),
    /until must be a valid calendar date/,
  );
  assert.equal(getSchedule(profile, item.id).recurrence.until, undefined);
  assert.equal(
    (db.prepare(
      "SELECT COUNT(*) AS count FROM schedules WHERE profile_id = ? AND title IN (?, ?)",
    ).get(profile.id, "bad workday until", "bad daily until") as { count: number }).count,
    0,
  );
  db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(profile.id, item.id);
});

test("workday recurrence skips statutory holidays and weekends", () => {
  ingestYear(2026);
  const item = createWorkday();
  assert.equal(item.recurrence.frequency, "workday");

  // 2026-01-30 是周五，09:00（Asia/Shanghai）= 01:00Z；08:30 本地时下一触发就是当天。
  assert.equal(
    findOccurrence(item, atUtc("2026-01-30T00:30:00.000Z"), true)?.toISO(),
    "2026-01-30T01:00:00.000Z",
  );
  // 10:00 本地时当天已过 → 跳过 1/31（周六）、2/1-2/8（春节假期）→ 2/9 周一。
  assert.equal(
    findOccurrence(item, atUtc("2026-01-30T02:00:00.000Z"), true)?.toISO(),
    "2026-02-09T01:00:00.000Z",
  );
});

test("workday recurrence treats make-up weekend workdays as workdays", () => {
  ingestYear(2026);
  db.prepare(`
    INSERT OR REPLACE INTO cn_holiday_days(date, year, day_type, name, source, created_at, updated_at)
    VALUES('2026-02-14', 2026, 'workday', '春节', 'test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  const item = createWorkday();
  // 2/13 周五 10:00 本地 → 下一工作日是调休上班的周六 2/14。
  assert.equal(
    findOccurrence(item, atUtc("2026-02-13T02:00:00.000Z"), true)?.toISO(),
    "2026-02-14T01:00:00.000Z",
  );
});

test("holiday recurrence only fires on statutory holiday days, not ordinary weekends", () => {
  ingestYear(2026);
  const item = createSchedule(profile, {
    title: "法定节假日提醒",
    calendar: "solar",
    date: "2026-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "holiday",
  });
  assert.equal(item.recurrence.frequency, "holiday");
  assert.equal(
    findOccurrence(item, atUtc("2026-01-30T00:00:00.000Z"), true)?.toISO(),
    "2026-02-01T01:00:00.000Z",
  );
  // 2/1 10:00 本地 → 下一天 2/2。
  assert.equal(
    findOccurrence(item, atUtc("2026-02-01T02:00:00.000Z"), true)?.toISO(),
    "2026-02-02T01:00:00.000Z",
  );
  // 3/6 周五之后没有端午前（6/1）以外的普通周末触发 → 4/4 清明。
  assert.equal(
    findOccurrence(item, atUtc("2026-03-06T00:00:00.000Z"), true)?.toISO(),
    "2026-04-04T01:00:00.000Z",
  );
});

test("workday occurrence respects the anchor date like RRule dtstart", () => {
  ingestYear(2026);
  const item = createWorkday({ date: "2026-01-15" });
  assert.equal(
    findOccurrence(item, atUtc("2026-01-05T00:00:00.000Z"), true)?.toISO(),
    "2026-01-15T01:00:00.000Z",
  );
});

test("workday occurrence reaches anchors more than two years in the future", () => {
  ingestYear(2030);
  const item = createWorkday({ date: "2030-01-01" });
  // 2030-01-01 至 01-03 是元旦假期，锚点后的第一个工作日是 1/4 周五。
  assert.equal(
    findOccurrence(item, atUtc("2025-06-01T00:00:00.000Z"), true)?.toISO(),
    "2030-01-04T01:00:00.000Z",
  );
});

test("workday occurrence stops at the first uncovered year instead of guessing", () => {
  ingestYear(2026);
  clearYear(2027);
  const item = createWorkday({ date: "2027-01-01" });
  // 2026 覆盖但已无剩余工作日，2027 无数据 → null，不跨过缺失年份。
  assert.equal(findOccurrence(item, atUtc("2026-12-31T02:00:00.000Z"), true), null);
});

test("workday recurrence honours until", () => {
  ingestYear(2026);
  const item = createWorkday({ recurrence: { frequency: "workday", until: "2026-01-30" } });
  assert.equal(
    findOccurrence(item, atUtc("2026-01-29T00:30:00.000Z"), true)?.toISO(),
    "2026-01-29T01:00:00.000Z",
  );
  assert.equal(
    findOccurrence(item, atUtc("2026-01-30T00:30:00.000Z"), true)?.toISO(),
    "2026-01-30T01:00:00.000Z",
  );
  assert.equal(findOccurrence(item, atUtc("2026-01-30T02:00:00.000Z"), true), null);
});

test("workday recurrence honours count including occurrences before from", () => {
  ingestYear(2026);
  const item = createWorkday({ recurrence: { frequency: "workday", count: 2 } });
  // 2026-01-01 至 01-03 是元旦假期，第一个工作日是 1/5 周一。
  assert.equal(
    findOccurrence(item, atUtc("2026-01-05T00:30:00.000Z"), true)?.toISO(),
    "2026-01-05T01:00:00.000Z",
  );
  assert.equal(
    findOccurrence(item, atUtc("2026-01-05T02:00:00.000Z"), true)?.toISO(),
    "2026-01-06T01:00:00.000Z",
  );
  // 前两个 occurrence 已消耗（1/5 早于 from、1/6 也早于 from），再无第三次。
  assert.equal(findOccurrence(item, atUtc("2026-01-06T02:00:00.000Z"), true), null);
});

test("workday schedule is created disabled when no holiday data covers the search range", () => {
  const year = FIXED_TEST_YEAR;
  clearYear(year);
  clearYear(year + 1);
  const item = createSchedule(profile, {
    title: "waiting for holiday data",
    calendar: "solar",
    date: `${year}-01-01`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  });
  assert.equal(item.enabled, false);
  assert.equal(item.nextRunAt, undefined);
  const row = db.prepare("SELECT enabled, next_run_at, status FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { enabled: 0, next_run_at: null, status: "active" });
});

test("reconcileHolidaySchedules revives workday schedules once a year becomes ready", () => {
  const year = FIXED_TEST_YEAR;
  clearYear(year);
  clearYear(year + 1);
  const item = createSchedule(profile, {
    title: "revive me",
    calendar: "solar",
    date: `${year}-01-01`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  }, FIXED_TEST_AT());
  assert.equal(item.enabled, false);

  ingestYear(year);
  ingestYear(year + 1);
  const summary = reconcileHolidaySchedules(FIXED_TEST_AT());
  assert.equal(summary.scanned >= 1, true);
  assert.equal(summary.updated >= 1, true);

  const revived = getSchedule(profile, item.id);
  assert.equal(revived.enabled, true);
  assert.ok(revived.nextRunAt);
  assert.equal(revived.status, "active");
  assert.equal(revived.version, 1); // 派生状态重算不推进内容版本
});

test("reconcileHolidaySchedules repairs workday schedules across profiles", () => {
  const year = FIXED_TEST_YEAR;
  clearYear(year);
  clearYear(year + 1);
  const other = requireProfileContext("schedule-holiday-other");
  const first = createSchedule(profile, {
    title: "profile a workday",
    calendar: "solar",
    date: `${year}-01-01`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  }, FIXED_TEST_AT());
  const second = createSchedule(other, {
    title: "profile b workday",
    calendar: "solar",
    date: `${year}-01-01`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  }, FIXED_TEST_AT());
  assert.equal(first.enabled, false);
  assert.equal(second.enabled, false);

  ingestYear(year);
  ingestYear(year + 1);
  reconcileHolidaySchedules(FIXED_TEST_AT());
  assert.equal(getSchedule(profile, first.id).enabled, true);
  assert.equal(getSchedule(other, second.id).enabled, true);
});

test("hydration sanitizes unsupported workday rows", () => {
  const base = {
    profile_id: "x",
    id: "lunar-workday",
    type: "todo",
    title: "dirty row",
    note: null,
    priority: "normal",
    status: "active",
    calendar: "lunar",
    date: null,
    lunar_month: 1,
    lunar_day: 1,
    leap_month_policy: null,
    time: "09:00",
    all_day: 0,
    timezone: "Asia/Shanghai",
    recurrence_json: '{"frequency":"workday","interval":1,"calendar":"lunar"}',
    reminders_json: '[{"id":"reminder-1","minutesBefore":0}]',
    deadline_at: null,
    deadline_offset_minutes: null,
    enabled: 1,
    next_run_at: null,
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const lunarItem = hydrateRow(base);
  assert.equal(lunarItem.recurrence.frequency, "once");

  const intervalItem = hydrateRow({
    ...base,
    id: "solar-workday-interval",
    calendar: "solar",
    date: "2026-01-01",
    recurrence_json: '{"frequency":"workday","interval":5,"calendar":"solar"}',
  });
  assert.equal(intervalItem.recurrence.frequency, "workday");
  assert.equal(intervalItem.recurrence.interval, 1);
});

test("processDue keeps a workday schedule active-but-disabled when next-year data is missing", async () => {
  ingestYear(2026);
  clearYear(2027);
  db.prepare("UPDATE schedules SET enabled = 0").run();
  insertScheduleRow("no-data-wd", '{"frequency":"workday","interval":1,"calendar":"solar"}', "2026-12-31T01:00:00.000Z");

  await runDueSchedules(new Date("2026-12-31T01:00:00.000Z"));
  const row = db.prepare("SELECT enabled, next_run_at, status FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, "no-data-wd") as Record<string, unknown>;
  assert.deepEqual({ ...row }, { enabled: 0, next_run_at: null, status: "active" });
});

test("processDue marks a workday schedule completed when until is exhausted", async () => {
  ingestYear(2026);
  db.prepare("UPDATE schedules SET enabled = 0").run();
  insertScheduleRow(
    "until-wd",
    '{"frequency":"workday","interval":1,"calendar":"solar","until":"2026-06-30"}',
    "2026-06-30T01:00:00.000Z",
  );

  await runDueSchedules(new Date("2026-06-30T01:00:00.000Z"));
  const row = db.prepare("SELECT enabled, next_run_at, status FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, "until-wd") as Record<string, unknown>;
  assert.deepEqual({ ...row }, { enabled: 0, next_run_at: null, status: "completed" });
});

// ---------------------------------------------------------------------------
// T4：创建/更新/reconcile 必须区分「真正耗尽」与「无数据暂不可算」
// ---------------------------------------------------------------------------

test("T4: createSchedule marks an exhausted count workday recurrence as completed", () => {
  const year = FIXED_TEST_YEAR;
  ingestYear(year);
  const item = createSchedule(profile, {
    title: "exhausted count",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "workday", count: 1 },
  }, FIXED_TEST_AT());
  assert.equal(item.status, "completed");
  assert.equal(item.enabled, false);
  const row = db.prepare("SELECT status, enabled FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { status: "completed", enabled: 0 });
});

test("T4: createSchedule marks an exhausted until workday recurrence as completed", () => {
  const year = FIXED_TEST_YEAR;
  ingestYear(year);
  const item = createSchedule(profile, {
    title: "exhausted until",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "workday", until: `${year}-01-10` },
  });
  assert.equal(item.status, "completed");
  assert.equal(item.enabled, false);
});

test("T4: createSchedule keeps active-but-disabled when until is future but data is missing", () => {
  const year = FIXED_TEST_YEAR;
  clearYear(year);
  clearYear(year + 1);
  const item = createSchedule(profile, {
    title: "future until without data",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "workday", until: `${year + 1}-12-31` },
  }, FIXED_TEST_AT());
  assert.equal(item.status, "active");
  assert.equal(item.enabled, false);
});

test("T4: reconcile transitions an exhausted-but-pending workday schedule to completed", () => {
  const year = FIXED_TEST_YEAR;
  ingestYear(year);
  const item = createSchedule(profile, {
    title: "reconcile exhausted count",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "workday", count: 1 },
  }, FIXED_TEST_AT());
  assert.equal(item.status, "completed");

  // 模拟修复前落库的僵尸态：active + 停用 + 无 next_run_at。
  db.prepare("UPDATE schedules SET status = 'active', enabled = 0, next_run_at = NULL WHERE profile_id = ? AND id = ?")
    .run(profile.id, item.id);
  const summary = reconcileHolidaySchedules(FIXED_TEST_AT());
  assert.equal(summary.updated >= 1, true);

  const row = db.prepare("SELECT status, enabled, next_run_at FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { status: "completed", enabled: 0, next_run_at: null });
});

test("T4: updateSchedule marks an exhausted until workday recurrence as completed", () => {
  const year = FIXED_TEST_YEAR;
  ingestYear(year);
  const item = createSchedule(profile, {
    title: "update to exhausted until",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  }, FIXED_TEST_AT());
  assert.equal(item.status, "active");
  assert.equal(item.enabled, true);

  const updated = updateSchedule(profile, item.id, {
    recurrence: { frequency: "workday", until: `${year}-01-10` },
  }, FIXED_TEST_AT());
  assert.equal(updated.status, "completed");
  assert.equal(updated.enabled, false);
});

test("T4: archived exhausted workday schedules stay archived instead of becoming completed", () => {
  const year = FIXED_TEST_YEAR;
  ingestYear(year);
  const item = createSchedule(profile, {
    title: "archived and exhausted",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "workday", until: `${year}-01-10` },
    status: "archived",
  });
  assert.equal(item.status, "archived");
  assert.equal(item.enabled, false);
  const row = db.prepare("SELECT status, enabled FROM schedules WHERE profile_id = ? AND id = ?")
    .get(profile.id, item.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { status: "archived", enabled: 0 });
});

test("S6: completeSchedule advances a workday schedule past the completed occurrence immediately", () => {
  const year = FIXED_TEST_YEAR;
  ingestYear(year);
  const item = createSchedule(profile, {
    title: "complete advances workday",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  }, FIXED_TEST_AT());
  assert.ok(item.nextRunAt);
  const before = item.nextRunAt!;
  const completed = completeSchedule(profile, item.id, undefined, FIXED_TEST_AT());
  assert.equal(completed.status, "active");
  assert.ok(completed.nextRunAt);
  assert.notEqual(completed.nextRunAt, before);
  // 动态推算下一个工作日，而不是写死绝对日期（避免日期炸弹）
  assert.equal(completed.nextRunAt, nextWorkdayAfterIso(before));
  const fresh = getSchedule(profile, item.id);
  assert.equal(fresh.nextRunAt, completed.nextRunAt);
  assert.equal(fresh.enabled, true);
  db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(profile.id, item.id);
});

test("S6: reconcileHolidaySchedules skips a completed future occurrence when recalculating", () => {
  const year = FIXED_TEST_YEAR;
  ingestYear(year);
  const item = createSchedule(profile, {
    title: "reconcile skips completed workday",
    calendar: "solar",
    date: `${year}-01-05`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  }, FIXED_TEST_AT());
  const first = item.nextRunAt!;
  // 不写死 first 的绝对日期（日期炸弹）；只校验它确是 Asia/Shanghai 09:00 的合法工作日触发点
  const firstLocal = DateTime.fromISO(first, { zone: "Asia/Shanghai" });
  assert.ok(firstLocal.isValid, "nextRunAt 应为合法 ISO 时间");
  assert.equal(firstLocal.hour, 9);
  assert.equal(firstLocal.minute, 0);
  db.prepare(
    "INSERT OR REPLACE INTO schedule_occurrences(profile_id, schedule_id, occurrence_key, occurrence_at, status) VALUES(?, ?, ?, ?, 'completed')",
  ).run(profile.id, item.id, first, first);
  db.prepare(
    "UPDATE schedules SET next_run_at = ?, enabled = 1 WHERE profile_id = ? AND id = ?",
  ).run(first, profile.id, item.id);

  reconcileHolidaySchedules(FIXED_TEST_AT());

  const fresh = getSchedule(profile, item.id);
  assert.notEqual(fresh.nextRunAt, first);
  // 跳过已完成的 first，推进到其后的下一个工作日（动态推算，不写死日期）
  assert.equal(fresh.nextRunAt, nextWorkdayAfterIso(first));
  assert.equal(fresh.enabled, true);
  db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(profile.id, item.id);
});

// ---------------------------------------------------------------------------
// M1：schedule 跨年窗口日期按标题年覆盖判断，不按自然年猜测
// ---------------------------------------------------------------------------

function ingestHolidayFixture(file: string): void {
  const raw = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", file),
    "utf8",
  )) as Record<string, unknown>;
  ingestHolidayYear(parseDataset("holiday-cn", raw));
}

function ingestChineseDaysYear(year: number): void {
  const holidays: Record<string, string> = {};
  const workdays: Record<string, string> = {};
  for (const day of (syntheticRaw(year) as { days: Array<Record<string, unknown>> }).days) {
    const date = String(day.date);
    const name = String(day.name);
    if (day.isOffDay === true) holidays[date] = `Holiday,${name},1`;
    else workdays[date] = `Holiday,${name},1`;
  }
  ingestHolidayYear(parseDataset("chinese-days", { holidays, workdays, inLieuDays: {} }));
}

test("M1: workday occurrence does not guess late-December dates when only the natural year is ready", () => {
  clearYear(2018);
  clearYear(2019);
  ingestYear(2018); // 2018 标题年 synthetic 数据，不含 2018-12-20 后的行
  const item = createWorkday({ date: "2018-01-01" });

  // 2018-12-31 是周一，但权威数据属 2019 标题年；2019 未 ready 时不得按普通周历生成。
  assert.equal(findOccurrence(item, atUtc("2018-12-28T02:00:00.000Z"), true), null);
});

test("M1: holiday occurrence hits the next title-year data when only 2019 is ready", () => {
  clearYear(2018);
  clearYear(2019);
  ingestHolidayFixture("holiday-cn-2019.json");
  const item = createSchedule(profile, {
    title: "跨年元旦 holiday",
    calendar: "solar",
    date: "2018-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "holiday",
  });
  assert.equal(
    findOccurrence(item, atUtc("2018-12-28T00:00:00.000Z"), true)?.toISO(),
    "2018-12-30T01:00:00.000Z",
  );
  assert.equal(
    findOccurrence(item, atUtc("2018-12-31T00:30:00.000Z"), true)?.toISO(),
    "2018-12-31T01:00:00.000Z",
  );
});

test("M1: both years ready keeps cross-year holiday and make-up workday occurrences", () => {
  clearYear(2018);
  clearYear(2019);
  ingestYear(2018);
  ingestHolidayFixture("holiday-cn-2019.json");

  const holiday = createSchedule(profile, {
    title: "跨年元旦 holiday",
    calendar: "solar",
    date: "2018-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "holiday",
  });
  assert.equal(
    findOccurrence(holiday, atUtc("2018-12-31T00:30:00.000Z"), true)?.toISO(),
    "2018-12-31T01:00:00.000Z",
  );

  const workday = createWorkday({ date: "2018-01-01" });
  assert.equal(
    findOccurrence(workday, atUtc("2018-12-28T02:00:00.000Z"), true)?.toISO(),
    "2018-12-29T01:00:00.000Z",
  );
});

test("M1: ordinary dates keep using the natural-year weekday fallback", () => {
  clearYear(2018);
  clearYear(2019);
  ingestYear(2018);
  const item = createWorkday({ date: "2018-01-01" });
  // 2018-06-29 是周五；之后第一个普通工作日是 2018-07-02 周一。
  assert.equal(
    findOccurrence(item, atUtc("2018-06-29T02:00:00.000Z"), true)?.toISO(),
    "2018-07-02T01:00:00.000Z",
  );
});

test("N1: schedule does not guess cross-year dates when only chinese-days next-year data is ready", () => {
  clearYear(2018);
  clearYear(2019);
  ingestChineseDaysYear(2019); // 仅 2019 自然年数据，不含 2018-12 行
  const item = createWorkday({ date: "2018-01-01" });
  assert.equal(findOccurrence(item, atUtc("2018-12-28T02:00:00.000Z"), true), null);
});
