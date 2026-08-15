import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DateTime } from "luxon";
import type { HolidayYearDataset } from "../src/modules/holiday/provider.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-holiday-calendar-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "holiday-calendar";

const {
  dayInfo,
  ensureHolidayYear,
  holidayYearView,
  ingestHolidayYear,
  isDateCoveredByHolidayData,
  isHolidayYearReady,
  nextHoliday,
  readHolidayYear,
  refreshHolidayCalendar,
  yearStatus,
} = await import("../src/modules/holiday/calendar.js");
const { parseDataset } = await import("../src/modules/holiday/provider.js");
const { getDatabase, resetDatabaseForTests } = await import("../src/core/database.js");
const db = getDatabase();

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

function syntheticDataset(year: number): HolidayYearDataset {
  return parseDataset("holiday-cn", syntheticRaw(year));
}

/** 构造 chinese-days 单自然年数据；crossNewYear=true 时给 2018 加 12/29-31 跨年行；
 * singleDayNewYear=true 时元旦只保留 1/1（贴近真实 2019 形态，便于断言合并后的 3 天连休）。 */
function chineseDaysDataset(year: number, crossNewYear = false, singleDayNewYear = false): HolidayYearDataset {
  const holidays: Record<string, string> = {};
  const workdays: Record<string, string> = {};
  const days = (syntheticRaw(year) as { days: Array<Record<string, unknown>> }).days
    .filter((day) => !singleDayNewYear || day.name !== "元旦" || String(day.date) === `${year}-01-01`);
  for (const day of days) {
    const date = String(day.date);
    const name = String(day.name);
    if (day.isOffDay === true) holidays[date] = `Holiday,${name},1`;
    else workdays[date] = `Holiday,${name},1`;
  }
  if (crossNewYear) {
    workdays[`${year}-12-29`] = "Holiday,元旦,1";
    holidays[`${year}-12-30`] = "Holiday,元旦,1";
    holidays[`${year}-12-31`] = "Holiday,元旦,1";
  }
  return parseDataset("chinese-days", { holidays, workdays, inLieuDays: {} });
}

function loadFixture(year = 2025): HolidayYearDataset {
  const raw = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", `holiday-cn-${year}.json`),
    "utf8",
  )) as Record<string, unknown>;
  return parseDataset("holiday-cn", raw);
}

test("ingest stores a year atomically and is idempotent for the same payload", () => {
  const dataset = loadFixture();
  assert.equal(readHolidayYear(2025), undefined);
  const first = ingestHolidayYear(dataset, new Date("2025-01-01T00:00:00.000Z"));
  assert.equal(first.changed, true);
  assert.equal(first.days, dataset.days.length);
  assert.equal(isHolidayYearReady(2025), true);
  assert.equal(readHolidayYear(2025)?.days.length, dataset.days.length);
  assert.equal(yearStatus(2025)?.source, "holiday-cn");

  const second = ingestHolidayYear(dataset, new Date("2025-02-01T00:00:00.000Z"));
  assert.equal(second.changed, false);
  assert.equal(yearStatus(2025)?.fetchedAt, "2025-01-01T00:00:00.000Z");
});

test("ingest replaces an existing year payload", () => {
  const first = syntheticDataset(2025);
  ingestHolidayYear(first);
  const before = readHolidayYear(2025)?.days.length as number;

  const raw = syntheticRaw(2025) as { days: Array<Record<string, unknown>> };
  raw.days = raw.days.filter((day) => day.name !== "春节" || Number(String(day.date).slice(8, 10)) <= 5);
  const reduced = parseDataset("holiday-cn", raw); // 春节 8 天 → 5 天，七个节日名仍齐全
  const result = ingestHolidayYear(reduced);
  assert.equal(result.changed, true);
  const after = readHolidayYear(2025)?.days.length as number;
  assert.equal(after, before - 3);
  assert.equal(readHolidayYear(2025)!.days.filter((day) => day.name === "春节").length, 5);
});

test("dayInfo classifies holidays, make-up workdays, weekdays and weekends", () => {
  ingestHolidayYear(loadFixture());
  assert.deepEqual(dayInfo("2025-01-01"), {
    date: "2025-01-01",
    isWorkday: false,
    isHoliday: true,
    dayType: "holiday",
    name: "元旦",
    note: "法定节假日",
  });
  assert.deepEqual(dayInfo("2025-01-26"), {
    date: "2025-01-26",
    isWorkday: true,
    isHoliday: false,
    dayType: "workday",
    name: "春节",
    note: "调休上班日（春节补班）",
  });
  assert.equal(dayInfo("2025-01-27")?.dayType, "weekday");
  assert.equal(dayInfo("2025-01-27")?.isWorkday, true);
  assert.equal(dayInfo("2025-01-25")?.dayType, "weekend");
  assert.equal(dayInfo("2025-01-25")?.isWorkday, false);
  assert.equal(dayInfo("not-a-date"), null);
});

test("holidayYearView groups consecutive holiday days and lists make-up workdays", () => {
  ingestHolidayYear(loadFixture());
  const view = holidayYearView(2025);
  assert.ok(view);
  assert.equal(view.year, 2025);
  assert.equal(view.periods.length, 6);
  assert.equal(view.workdays.length, 5);
  const springFestival = view.periods.find((period) => period.name === "春节");
  assert.ok(springFestival);
  assert.equal(springFestival.startDate, "2025-01-28");
  assert.equal(springFestival.endDate, "2025-02-04");
  assert.equal(springFestival.days, 8);
  assert.deepEqual(springFestival.makeUpWorkdays.map((day) => day.date), ["2025-01-26", "2025-02-08"]);
  const national = view.periods.find((period) => period.name.includes("国庆"));
  assert.ok(national);
  assert.equal(national.days, 8);
  assert.equal(national.name, "国庆节、中秋节");
});

test("nextHoliday reports an upcoming period with countdown and make-up workdays", () => {
  ingestHolidayYear(loadFixture());
  const result = nextHoliday(new Date("2025-01-20T08:00:00+08:00"));
  assert.equal(result.status, "upcoming");
  assert.equal(result.holidayName, "春节");
  assert.equal(result.countdownDays, 8);
  assert.equal(result.startDate, "2025-01-28");
  assert.deepEqual(result.makeUpWorkdays?.map((day) => day.date), ["2025-01-26", "2025-02-08"]);
});

test("nextHoliday reports an ongoing period with remaining days", () => {
  ingestHolidayYear(loadFixture());
  const result = nextHoliday(new Date("2025-01-29T00:00:00+08:00"));
  assert.equal(result.status, "ongoing");
  assert.equal(result.holidayName, "春节");
  assert.equal(result.countdownDays, 0);
  assert.equal(result.remainingDays, 6);
});

test("nextHoliday returns unknown when the next year is not covered", () => {
  ingestHolidayYear(loadFixture());
  db.prepare("DELETE FROM cn_holiday_year_meta WHERE year = ?").run(2026);
  db.prepare("DELETE FROM cn_holiday_days WHERE year = ?").run(2026);
  const result = nextHoliday(new Date("2025-12-31T12:00:00+08:00"));
  assert.equal(result.status, "unknown");
  // H6：ready 年份的覆盖边界与 holidayYearView 一致，到 12-19 为止。
  assert.equal(result.coveredUntil, "2025-12-19");
  assert.match(result.message ?? "", /2026 年节假日安排尚未获取/);
});

test("nextHoliday crosses into a covered next year", () => {
  ingestHolidayYear(loadFixture());
  ingestHolidayYear(syntheticDataset(2026));
  const result = nextHoliday(new Date("2025-12-31T12:00:00+08:00"));
  assert.equal(result.status, "upcoming");
  assert.equal(result.holidayName, "元旦");
  assert.equal(result.startDate, "2026-01-01");
  assert.equal(result.countdownDays, 1);
});

test("ensureHolidayYear skips fetching when the year is already ready", async () => {
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    return syntheticDataset(year);
  };
  await ensureHolidayYear(2030, { fetch });
  const record = await ensureHolidayYear(2030, { fetch });
  assert.equal(record.year, 2030);
  assert.deepEqual(calls, [2030]);
});

test("ensureHolidayYear records failures and respects the attempt cooldown", async () => {
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    throw new Error(`HTTP 503 for ${year}`);
  };
  await assert.rejects(() => ensureHolidayYear(2040, { fetch, at: new Date("2030-01-01T00:00:00.000Z") }), /HTTP 503/);
  assert.equal(calls.length, 1);
  assert.equal(yearStatus(2040)?.ready, false);
  assert.ok(yearStatus(2040)?.lastAttemptAt);

  await assert.rejects(
    () => ensureHolidayYear(2040, { fetch, at: new Date("2030-01-01T01:00:00.000Z") }),
    /分钟后自动重试/,
  );
  assert.equal(calls.length, 1);
});

test("ensureHolidayYear fetches again after the cooldown expires", async () => {
  const calls: number[] = [];
  let fail = true;
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    if (fail) throw new Error("temporary outage");
    return syntheticDataset(year);
  };
  const firstAt = new Date("2030-01-01T00:00:00.000Z");
  await assert.rejects(() => ensureHolidayYear(2041, { fetch, at: firstAt }));
  fail = false;
  const record = await ensureHolidayYear(2041, {
    fetch,
    at: new Date(firstAt.getTime() + 7 * 60 * 60 * 1000),
  });
  assert.equal(record.year, 2041);
  assert.deepEqual(calls, [2041, 2041]);
});

test("refreshHolidayCalendar only targets the current year before October", async () => {
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    return syntheticDataset(year);
  };
  const result = await refreshHolidayCalendar({
    fetch,
    at: new Date("2042-08-01T00:00:00.000Z"),
  });
  assert.deepEqual(result.years, [2042]);
  assert.deepEqual(calls, [2042]);
  assert.equal(result.fetched.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("refreshHolidayCalendar also targets next year from October onward", async () => {
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    return syntheticDataset(year);
  };
  const result = await refreshHolidayCalendar({
    fetch,
    at: new Date("2034-11-01T00:00:00.000Z"),
  });
  assert.deepEqual(result.years, [2034, 2035]);
  assert.deepEqual(calls, [2034, 2035]);
  assert.equal(result.fetched.length, 2);
});

test("refreshHolidayCalendar keeps going when next-year fetch fails", async () => {
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    if (year === 2033) throw new Error("not released yet");
    return syntheticDataset(year);
  };
  const result = await refreshHolidayCalendar({
    fetch,
    cooldownMs: 0,
    at: new Date("2032-11-01T00:00:00.000Z"),
  });
  assert.deepEqual(result.years, [2032, 2033]);
  assert.equal(result.fetched.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].year, 2033);
});

test("holidayYearView returns undefined for an uncovered year", () => {
  db.prepare("DELETE FROM cn_holiday_year_meta WHERE year = ?").run(2099);
  db.prepare("DELETE FROM cn_holiday_days WHERE year = ?").run(2099);
  assert.equal(holidayYearView(2099), undefined);
  assert.equal(isHolidayYearReady(2099), false);
});

test("T2: cross-year New Year days are ingested and queried under their natural calendar year", () => {
  const raw = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", "holiday-cn-2019.json"),
    "utf8",
  )) as Record<string, unknown>;
  ingestHolidayYear(parseDataset("holiday-cn", raw));

  // 按自然年可命中：跨年日期存在 2018 年下，meta ready 属于 2019 年数据集。
  assert.equal(dayInfo("2018-12-29")?.dayType, "workday");
  assert.equal(dayInfo("2018-12-30")?.dayType, "holiday");
  const crossYearRows = db.prepare(
    "SELECT date, day_type FROM cn_holiday_days WHERE year = 2018 ORDER BY date",
  ).all() as Array<{ date: string; day_type: string }>;
  assert.deepEqual(crossYearRows.map((row) => ({ date: row.date, day_type: row.day_type })), [
    { date: "2018-12-29", day_type: "workday" },
    { date: "2018-12-30", day_type: "holiday" },
    { date: "2018-12-31", day_type: "holiday" },
  ]);

  const view = holidayYearView(2019);
  const newYear = view?.periods.find((period) => period.name === "元旦");
  assert.equal(newYear?.startDate, "2018-12-30");
  assert.equal(newYear?.endDate, "2019-01-01");
  assert.equal(newYear?.days, 3);
  assert.deepEqual(newYear?.makeUpWorkdays.map((day) => day.date), ["2018-12-29"]);
});

// ---------------------------------------------------------------------------
// H1：ingest 不能按标题年整年删除相邻标题年写入的跨年行
// ---------------------------------------------------------------------------

function crossYearRows(): Array<{ date: string; day_type: string }> {
  const rows = db.prepare(`
    SELECT date, day_type FROM cn_holiday_days
    WHERE date IN ('2018-12-29', '2018-12-30', '2018-12-31')
    ORDER BY date
  `).all() as Array<{ date: string; day_type: string }>;
  return rows.map((row) => ({ date: row.date, day_type: row.day_type }));
}

function clearYears(years: number[]): void {
  for (const year of years) {
    db.prepare("DELETE FROM cn_holiday_days WHERE year = ?").run(year);
    db.prepare("DELETE FROM cn_holiday_year_meta WHERE year = ?").run(year);
  }
}

test("H1: ingesting the previous title year keeps cross-year rows written by the next title year", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(loadFixture(2019));   // 写入 2018-12-29/30/31
  ingestHolidayYear(syntheticDataset(2018)); // 不得按 year=2018 整年删除
  assert.deepEqual(crossYearRows(), [
    { date: "2018-12-29", day_type: "workday" },
    { date: "2018-12-30", day_type: "holiday" },
    { date: "2018-12-31", day_type: "holiday" },
  ]);
});

test("H1: reverse order (2018 first, then 2019) also yields the same cross-year rows without duplicates", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(syntheticDataset(2018));
  ingestHolidayYear(loadFixture(2019));
  assert.deepEqual(crossYearRows(), [
    { date: "2018-12-29", day_type: "workday" },
    { date: "2018-12-30", day_type: "holiday" },
    { date: "2018-12-31", day_type: "holiday" },
  ]);
});

test("H1: unchanged short-circuit still prevents duplicate inserts for cross-year datasets", () => {
  clearYears([2018, 2019]);
  const dataset = loadFixture(2019);
  const first = ingestHolidayYear(dataset, new Date("2025-01-01T00:00:00.000Z"));
  const second = ingestHolidayYear(dataset, new Date("2025-02-01T00:00:00.000Z"));
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(crossYearRows(), [
    { date: "2018-12-29", day_type: "workday" },
    { date: "2018-12-30", day_type: "holiday" },
    { date: "2018-12-31", day_type: "holiday" },
  ]);
  assert.equal(yearStatus(2019)?.fetchedAt, "2025-01-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// H2：holidayYearView / nextHoliday 按标题年日期范围查询并合并跨年连休期
// ---------------------------------------------------------------------------

function singleDayNewYearDataset(year: number): HolidayYearDataset {
  const raw = syntheticRaw(year) as { days: Array<Record<string, unknown>> };
  raw.days = raw.days.filter((day) => day.name !== "元旦" || String(day.date) === `${year}-01-01`);
  return parseDataset("holiday-cn", raw);
}

/** 2018 标题年文件：跨年元旦 2017-12-30~2018-01-01，补班 2017-12-23。 */
function title2018Dataset(): HolidayYearDataset {
  const raw = syntheticRaw(2018) as { days: Array<Record<string, unknown>> };
  raw.days = raw.days.filter((day) => day.name !== "元旦" || String(day.date) === "2018-01-01");
  raw.days.push({ name: "元旦", date: "2017-12-23", isOffDay: false });
  raw.days.push({ name: "元旦", date: "2017-12-30", isOffDay: true });
  raw.days.push({ name: "元旦", date: "2017-12-31", isOffDay: true });
  return parseDataset("holiday-cn", raw);
}

/** 2023 标题年文件：元旦 2022-12-31~2023-01-02。 */
function title2023Dataset(): HolidayYearDataset {
  const raw = syntheticRaw(2023) as { days: Array<Record<string, unknown>> };
  raw.days = raw.days.filter((day) => day.name !== "元旦" || ["2023-01-01", "2023-01-02"].includes(String(day.date)));
  raw.days.push({ name: "元旦", date: "2022-12-31", isOffDay: true });
  return parseDataset("holiday-cn", raw);
}

/** 2024 标题年文件：元旦 2023-12-30~2024-01-01。 */
function title2024Dataset(): HolidayYearDataset {
  const raw = syntheticRaw(2024) as { days: Array<Record<string, unknown>> };
  raw.days = raw.days.filter((day) => day.name !== "元旦" || String(day.date) === "2024-01-01");
  raw.days.push({ name: "元旦", date: "2023-12-30", isOffDay: true });
  raw.days.push({ name: "元旦", date: "2023-12-31", isOffDay: true });
  return parseDataset("holiday-cn", raw);
}

test("H2: holidayYearView merges the cross-year New Year period into one period", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(syntheticDataset(2018));
  ingestHolidayYear(loadFixture(2019));

  const view = holidayYearView(2019);
  const newYear = view?.periods.find((period) =>
    period.name === "元旦" && period.startDate === "2018-12-30");
  assert.ok(newYear);
  assert.equal(newYear.endDate, "2019-01-01");
  assert.equal(newYear.days, 3);
  assert.deepEqual(newYear.makeUpWorkdays.map((day) => day.date), ["2018-12-29"]);
});

test("H2: nextHoliday reports the merged cross-year New Year period", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(syntheticDataset(2018));
  ingestHolidayYear(loadFixture(2019));

  const result = nextHoliday(new Date("2018-12-28T08:00:00+08:00"));
  assert.equal(result.status, "upcoming");
  assert.equal(result.holidayName, "元旦");
  assert.equal(result.startDate, "2018-12-30");
  assert.equal(result.endDate, "2019-01-01");
  assert.equal(result.days, 3);
  assert.equal(result.countdownDays, 2);
  assert.deepEqual(result.makeUpWorkdays?.map((day) => day.date), ["2018-12-29"]);
});

test("H2: a single-day New Year of the following year is not merged into the current title-year view", () => {
  clearYears([2018, 2019, 2020]);
  ingestHolidayYear(loadFixture(2019));
  ingestHolidayYear(singleDayNewYearDataset(2020));

  const view2019 = holidayYearView(2019);
  const newYear2019 = view2019?.periods.find((period) =>
    period.name === "元旦" && period.startDate === "2018-12-30");
  assert.equal(newYear2019?.endDate, "2019-01-01");

  const view2020 = holidayYearView(2020);
  const newYear2020 = view2020?.periods.find((period) => period.name === "元旦");
  assert.equal(newYear2020?.startDate, "2020-01-01");
  assert.equal(newYear2020?.endDate, "2020-01-01");
  assert.equal(newYear2020?.days, 1);
});

// ---------------------------------------------------------------------------
// K1：视图不得越界拉入下一标题年的 12 月下旬行，同名元旦段补班不得串染
// ---------------------------------------------------------------------------

test("K1: previous title-year view shows only its own New Year period without next-year make-up contamination", () => {
  clearYears([2017, 2018, 2019]);
  ingestHolidayYear(title2018Dataset());
  ingestHolidayYear(loadFixture(2019));

  const view = holidayYearView(2018);
  assert.ok(view);
  const newYearPeriods = view.periods.filter((period) => period.name === "元旦");
  assert.equal(newYearPeriods.length, 1);
  assert.equal(newYearPeriods[0].startDate, "2017-12-30");
  assert.equal(newYearPeriods[0].endDate, "2018-01-01");
  assert.deepEqual(newYearPeriods[0].makeUpWorkdays.map((day) => day.date), ["2017-12-23"]);
  // 2018-12-20 起的行属于 2019 标题年，不得外泄进 2018 视图。
  assert.ok(!view.periods.some((period) => period.startDate >= "2018-12-20"));
});

test("K1: next title-year view keeps its own merged New Year period and make-up day", () => {
  clearYears([2017, 2018, 2019]);
  ingestHolidayYear(title2018Dataset());
  ingestHolidayYear(loadFixture(2019));

  const view = holidayYearView(2019);
  const newYear = view?.periods.find((period) => period.name === "元旦");
  assert.ok(newYear);
  assert.equal(newYear.startDate, "2018-12-30");
  assert.equal(newYear.endDate, "2019-01-01");
  assert.equal(newYear.days, 3);
  assert.deepEqual(newYear.makeUpWorkdays.map((day) => day.date), ["2018-12-29"]);
});

test("K1: view(2023) does not leak the truncated 2023-12-30/31 segment written by the 2024 file", () => {
  clearYears([2022, 2023, 2024]);
  ingestHolidayYear(title2023Dataset());
  ingestHolidayYear(title2024Dataset());

  const view = holidayYearView(2023);
  assert.ok(view);
  assert.ok(!view.periods.some((period) => period.startDate >= "2023-12-20"));
  const newYear = view.periods.find((period) => period.name === "元旦");
  assert.equal(newYear?.startDate, "2022-12-31");
  assert.equal(newYear?.endDate, "2023-01-02");
  assert.equal(newYear?.days, 3);
});

// ---------------------------------------------------------------------------
// K3：nextHoliday 在当年未 ready、下一标题年已 ready 的跨年窗口内不提前 unknown
// ---------------------------------------------------------------------------

test("K3: nextHoliday uses the ready next title year inside the cross-year window", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(loadFixture(2019)); // 仅 2019 标题年 ready
  assert.equal(isHolidayYearReady(2018), false);

  const result = nextHoliday(new Date("2018-12-28T08:00:00+08:00"));
  assert.equal(result.status, "upcoming");
  assert.equal(result.holidayName, "元旦");
  assert.equal(result.startDate, "2018-12-30");
  assert.equal(result.endDate, "2019-01-01");
  assert.equal(result.days, 3);
});

test("K3: nextHoliday still returns unknown when neither year is ready", () => {
  clearYears([2018, 2019]);
  const result = nextHoliday(new Date("2018-12-28T08:00:00+08:00"));
  assert.equal(result.status, "unknown");
  assert.match(result.message ?? "", /2018 年节假日安排尚未获取/);
});

// ---------------------------------------------------------------------------
// M3：readHolidayYear 按标题年日期范围计数，包含跨年行
// ---------------------------------------------------------------------------

test("M3: readHolidayYear returns the complete title-year dataset including cross-year rows", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(loadFixture(2019));
  const record = readHolidayYear(2019);
  assert.equal(record?.days.length, 37);
  assert.ok(record!.days.some((day) => day.date === "2018-12-29" && day.dayType === "workday"));
  assert.ok(record!.days.some((day) => day.date === "2018-12-30" && day.dayType === "holiday"));
  assert.ok(record!.days.some((day) => day.date === "2018-12-31" && day.dayType === "holiday"));
});

test("M3: readHolidayYear for a previous title year does not absorb next title-year rows", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(title2018Dataset());
  ingestHolidayYear(loadFixture(2019));
  const record2018 = readHolidayYear(2018);
  assert.ok(record2018);
  assert.ok(!record2018.days.some((day) => day.date >= "2018-12-20"));
});

test("M3: refreshHolidayCalendar reports the complete title-year day count", async () => {
  clearYears([2019]);
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    if (year === 2019) return loadFixture(2019);
    throw new Error(`unexpected fetch for year ${year}`);
  };
  const result = await refreshHolidayCalendar({
    fetch,
    at: new Date("2019-06-01T00:00:00.000Z"),
  });
  assert.equal(result.fetched.length, 1);
  assert.equal(result.fetched[0]?.days.length, 37);
});

// ---------------------------------------------------------------------------
// N1：覆盖判断必须区分数据源——chinese-days 的 year+1 不含上一年 12 月下旬行
// ---------------------------------------------------------------------------

test("N1: chinese-days next-year data does not imply cross-year coverage", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(chineseDaysDataset(2019));
  assert.equal(isDateCoveredByHolidayData("2018-12-31"), false);
  assert.equal(isDateCoveredByHolidayData("2018-12-29"), false);
});

test("N1: holiday-cn next-year data still implies full cross-year coverage", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(loadFixture(2019));
  assert.equal(isDateCoveredByHolidayData("2018-12-31"), true);
  assert.equal(isDateCoveredByHolidayData("2018-12-29"), true);
});

test("N1: chinese-days natural-year data covers cross-year dates only when the row exists", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(chineseDaysDataset(2018, true));
  assert.equal(isDateCoveredByHolidayData("2018-12-31"), true);
  assert.equal(isDateCoveredByHolidayData("2018-12-29"), true);
  assert.equal(isDateCoveredByHolidayData("2018-12-20"), false);
});

// ---------------------------------------------------------------------------
// N3：chinese-days 标题年缺上一年 12 月行时，视图不得静默截断
// ---------------------------------------------------------------------------

test("N3: holidayYearView treats chinese-days title-year data without the previous natural year as incomplete", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(chineseDaysDataset(2019, false, true));
  assert.equal(holidayYearView(2019), undefined);
});

test("N3: nextHoliday does not show a truncated New Year when only chinese-days title-year data is ready", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(chineseDaysDataset(2019, false, true));
  const result = nextHoliday(new Date("2018-12-28T08:00:00+08:00"));
  assert.equal(result.status, "unknown");
});

test("N3: the view becomes complete once the previous natural year is also ready", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(chineseDaysDataset(2019, false, true));
  ingestHolidayYear(chineseDaysDataset(2018, true));
  const view = holidayYearView(2019);
  const newYear = view?.periods.find((period) => period.name === "元旦");
  assert.equal(newYear?.startDate, "2018-12-30");
  assert.equal(newYear?.endDate, "2019-01-01");
  assert.equal(newYear?.days, 3);
  assert.deepEqual(newYear?.makeUpWorkdays.map((day) => day.date), ["2018-12-29"]);
});

// ---------------------------------------------------------------------------
// N4：chinese-days 标题年 + holiday-cn 上一自然年 ready 时，视图不得静默截断
// ---------------------------------------------------------------------------

test("N4: mixed-source view is not silently truncated when the previous year is holiday-cn", () => {
  clearYears([2018, 2019]);
  ingestHolidayYear(title2018Dataset()); // holiday-cn 2018，不含 2018-12 月下旬行
  ingestHolidayYear(chineseDaysDataset(2019, false, true)); // chinese-days 2019，元旦仅 1/1
  assert.equal(holidayYearView(2019), undefined);
  assert.equal(nextHoliday(new Date("2018-12-28T08:00:00+08:00")).status, "unknown");
});

// ---------------------------------------------------------------------------
// H1：2015 特殊假日视图与补班关联
// ---------------------------------------------------------------------------

test("H1: holidayYearView shows the 2015 special holiday with its make-up workday", () => {
  clearYears([2014, 2015]);
  const raw = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", "holiday-cn-2015.json"),
    "utf8",
  )) as Record<string, unknown>;
  ingestHolidayYear(parseDataset("holiday-cn", raw));

  const view = holidayYearView(2015);
  assert.ok(view);
  const special = view.periods.find((period) =>
    period.name === "抗日战争暨世界反法西斯战争胜利70周年纪念日");
  assert.ok(special);
  assert.equal(special.startDate, "2015-09-03");
  assert.equal(special.endDate, "2015-09-05");
  assert.equal(special.days, 3);
  assert.deepEqual(special.makeUpWorkdays.map((day) => day.date), ["2015-09-06"]);
});

// ---------------------------------------------------------------------------
// H4：ingest 入口必须校验，非法 dataset 不得写库
// ---------------------------------------------------------------------------

test("H4: ingestHolidayYear rejects invalid datasets before marking the year ready", () => {
  clearYears([2050]);
  const base = syntheticDataset(2050);
  const invalid = {
    ...base,
    days: base.days.filter((day) => !day.name.includes("春节")),
  };
  assert.throws(() => ingestHolidayYear(invalid), /missing statutory holiday: 春节/);
  assert.equal(isHolidayYearReady(2050), false);
  assert.equal(readHolidayYear(2050), undefined);
  assert.equal(yearStatus(2050), undefined);
});
