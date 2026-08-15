import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DateTime } from "luxon";
import type { HolidayYearDataset } from "../src/modules/holiday/provider.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-holiday-module-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "holiday-module";

await import("../src/modules/index.js");
const { getModules } = await import("../src/core/registry.js");
const { getDatabase, resetDatabaseForTests } = await import("../src/core/database.js");
const { requireProfileContext } = await import("../src/core/profile.js");
const { dayInfo, holidayYearView, ingestHolidayYear } = await import("../src/modules/holiday/calendar.js");
const { parseDataset } = await import("../src/modules/holiday/provider.js");
const { createSchedule, getSchedule } = await import("../src/modules/schedule/service.js");
const holidayIndex = await import("../src/modules/holiday/index.js");
const { ensureDayCoverage, ensureYearForView } = holidayIndex;

const db = getDatabase();
const profile = requireProfileContext("holiday-module");
const holidayModule = getModules().find((module) => module.name === "holiday");

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

function tool(name: string) {
  const found = holidayModule?.tools?.find((entry) => entry.name === name);
  assert.ok(found, `missing holiday tool: ${name}`);
  return found!;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await tool(name).handler(args, profile);
  const text = result.content[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

test("holiday module registers four tools, a refresh job and a startup hook", () => {
  assert.ok(holidayModule);
  assert.deepEqual(
    (holidayModule!.tools ?? []).map((entry) => entry.name).sort(),
    ["is_workday", "list", "next", "refresh"],
  );
  assert.equal(holidayModule!.jobs?.length, 1);
  assert.equal(holidayModule!.jobs![0].name, "refresh_calendar");
  assert.equal(holidayModule!.jobs![0].cron, "0 2 * * *");
  assert.equal(holidayModule!.jobs![0].timezone, "Asia/Shanghai");
  assert.equal(typeof holidayModule!.onStart, "function");
});

test("holiday.list tool returns periods and make-up workdays for a ready year", async () => {
  ingestYear(2030);
  const result = await callTool("list", { year: 2030 });
  assert.equal(result.year, 2030);
  assert.equal((result.periods as unknown[]).length, 7);
  assert.deepEqual(result.workdays, []);
  const spring = (result.periods as Array<Record<string, unknown>>).find((period) => period.name === "春节");
  assert.equal(spring?.startDate, "2030-02-01");
  assert.equal(spring?.days, 8);
});

test("holiday.next tool computes countdown from a given date", async () => {
  const result = await callTool("next", { from: "2030-05-10" });
  assert.equal(result.status, "upcoming");
  assert.equal(result.holidayName, "端午节");
  assert.equal(result.startDate, "2030-06-01");
  assert.equal(result.countdownDays, 22);
});

test("holiday.next tool reports unknown for uncovered search years", async () => {
  db.prepare("DELETE FROM cn_holiday_year_meta WHERE year = ?").run(2032);
  db.prepare("DELETE FROM cn_holiday_days WHERE year = ?").run(2032);
  const result = await callTool("next", { from: "2031-12-31" });
  assert.equal(result.status, "unknown");
});

test("holiday.is_workday tool classifies holidays, weekdays and weekends", async () => {
  const holiday = await callTool("is_workday", { date: "2030-05-01" });
  assert.equal(holiday.dayType, "holiday");
  assert.equal(holiday.isWorkday, false);

  const weekday = await callTool("is_workday", { date: "2030-05-06" });
  assert.equal(weekday.dayType, "weekday");
  assert.equal(weekday.isWorkday, true);

  const weekend = await callTool("is_workday", { date: "2030-05-18" });
  assert.equal(weekend.dayType, "weekend");
  assert.equal(weekend.isWorkday, false);
});

test("holiday.refresh tool confirms a ready year and reconciles schedules", async () => {
  const result = await callTool("refresh", { year: 2030 });
  assert.equal(result.fetched, true);
  assert.equal(result.year, 2030);
  assert.equal(result.source, "holiday-cn");
  assert.equal(result.days, 32);
  assert.equal((result.scheduleReconcile as Record<string, unknown>).scanned, 0);
});

// ---------------------------------------------------------------------------
// K2：is_workday / list 冷启动补抓的标题年选择
// ---------------------------------------------------------------------------

function clearHolidayYears(years: number[]): void {
  for (const year of years) {
    db.prepare("DELETE FROM cn_holiday_days WHERE year = ?").run(year);
    db.prepare("DELETE FROM cn_holiday_year_meta WHERE year = ?").run(year);
  }
}

function fixtureDataset(file: string): HolidayYearDataset {
  const raw = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", file),
    "utf8",
  )) as Record<string, unknown>;
  return parseDataset("holiday-cn", raw);
}

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

test("K2: ensureDayCoverage fetches the next title year first for late-December dates", async () => {
  clearHolidayYears([2018, 2019]);
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    if (year === 2019) return fixtureDataset("holiday-cn-2019.json");
    throw new Error(`unexpected fetch for year ${year}`);
  };
  await ensureDayCoverage("2018-12-31", {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(calls, [2019]);
  assert.equal(dayInfo("2018-12-31")?.dayType, "holiday");
  assert.equal(dayInfo("2018-12-29")?.dayType, "workday");
});

test("K2: ensureDayCoverage skips fetching when the next title year is already ready", async () => {
  clearHolidayYears([2018, 2019]);
  ingestHolidayYear(fixtureDataset("holiday-cn-2019.json"));
  let calls = 0;
  const fetch = async (): Promise<HolidayYearDataset> => {
    calls += 1;
    throw new Error("fetch must not be called");
  };
  await ensureDayCoverage("2018-12-31", {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.equal(calls, 0);
  assert.equal(dayInfo("2018-12-30")?.dayType, "holiday");
});

test("K2: ensureYearForView ensures only the title year itself", async () => {
  clearHolidayYears([2018, 2019]);
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    if (year === 2018) return parseDataset("holiday-cn", syntheticRaw(2018));
    throw new Error(`unexpected fetch for year ${year}`);
  };
  await ensureYearForView(2018, {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(calls, [2018]);
  const view = holidayYearView(2018);
  assert.ok(view);
  assert.ok(view.periods.length > 0);
});

// ---------------------------------------------------------------------------
// M2：ensureDayCoverage 回退到自然年后必须确认目标日期有权威行
// ---------------------------------------------------------------------------

test("M2: ensureDayCoverage rejects a cross-year fallback when the natural year has no authoritative row", async () => {
  clearHolidayYears([2018, 2019]);
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    if (year === 2019) throw new Error("HTTP 503 for 2019");
    if (year === 2018) return parseDataset("holiday-cn", syntheticRaw(2018));
    throw new Error(`unexpected fetch for year ${year}`);
  };
  await assert.rejects(
    () => ensureDayCoverage("2018-12-31", {
      fetch,
      at: new Date("2025-08-15T00:00:00.000Z"),
    }),
    /HTTP 503 for 2019|缺失|无法判断/,
  );
  assert.deepEqual(calls, [2019, 2018]);
});

test("M2: ensureDayCoverage still accepts ordinary dates from the natural-year fallback", async () => {
  clearHolidayYears([2018, 2019]);
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    if (year === 2018) return parseDataset("holiday-cn", syntheticRaw(2018));
    throw new Error(`unexpected fetch for year ${year}`);
  };
  await ensureDayCoverage("2018-10-01", {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.equal(dayInfo("2018-10-01")?.dayType, "holiday");
});

test("M2: an authoritative next title year covers cross-year dates even without a row for the target", async () => {
  clearHolidayYears([2018, 2019]);
  ingestHolidayYear(fixtureDataset("holiday-cn-2019.json"));
  let calls = 0;
  const fetch = async (): Promise<HolidayYearDataset> => {
    calls += 1;
    throw new Error("fetch must not be called");
  };
  await ensureDayCoverage("2018-12-20", {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.equal(calls, 0);
  // 2019 标题年已覆盖，12/20 无权威行 → 普通周历兜底是正确行为（周四 weekday）。
  assert.equal(dayInfo("2018-12-20")?.dayType, "weekday");
});

// ---------------------------------------------------------------------------
// N2：ensureDayCoverage 的 year+1 权威覆盖必须区分 source
// ---------------------------------------------------------------------------

test("N2: ensureDayCoverage rejects when only chinese-days next-year data is ready", async () => {
  clearHolidayYears([2018, 2019]);
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    if (year === 2019) return chineseDaysDataset(2019);
    throw new Error("HTTP 503 for 2018");
  };
  await assert.rejects(
    () => ensureDayCoverage("2018-12-31", {
      fetch,
      at: new Date("2025-08-15T00:00:00.000Z"),
    }),
    /HTTP 503 for 2018|缺失|无法判断/,
  );
  assert.deepEqual(calls, [2019, 2018]);
});

test("N2: ensureDayCoverage falls back to chinese-days natural-year rows for cross-year dates", async () => {
  clearHolidayYears([2018, 2019]);
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    if (year === 2019) return chineseDaysDataset(2019);
    if (year === 2018) return chineseDaysDataset(2018, true);
    throw new Error(`unexpected fetch for year ${year}`);
  };
  await ensureDayCoverage("2018-12-31", {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(calls, [2019, 2018]);
  assert.equal(dayInfo("2018-12-31")?.dayType, "holiday");
  assert.equal(dayInfo("2018-12-29")?.dayType, "workday");
});

// ---------------------------------------------------------------------------
// N3：list(ensureYearForView) 对 chinese-days 标题年补齐上一自然年
// ---------------------------------------------------------------------------

test("N3: ensureYearForView backfills the previous natural year for chinese-days title-year data", async () => {
  clearHolidayYears([2018, 2019]);
  const calls: number[] = [];
  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    calls.push(year);
    if (year === 2019) return chineseDaysDataset(2019, false, true);
    if (year === 2018) return chineseDaysDataset(2018, true);
    throw new Error(`unexpected fetch for year ${year}`);
  };
  await ensureYearForView(2019, {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(calls, [2019, 2018]);
  const view = holidayYearView(2019);
  const newYear = view?.periods.find((period) => period.name === "元旦");
  assert.equal(newYear?.startDate, "2018-12-30");
  assert.equal(newYear?.endDate, "2019-01-01");
  assert.equal(newYear?.days, 3);
  assert.deepEqual(newYear?.makeUpWorkdays.map((day) => day.date), ["2018-12-29"]);
});

test("N3: ensureYearForView does not backfill for holiday-cn title-year data", async () => {
  clearHolidayYears([2018, 2019]);
  ingestHolidayYear(fixtureDataset("holiday-cn-2019.json"));
  let calls = 0;
  const fetch = async (): Promise<HolidayYearDataset> => {
    calls += 1;
    throw new Error("fetch must not be called");
  };
  await ensureYearForView(2019, {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.equal(calls, 0);
  const view = holidayYearView(2019);
  assert.ok(view);
  assert.equal(view.periods.find((period) => period.name === "元旦")?.days, 3);
});

// ---------------------------------------------------------------------------
// N4：chinese-days 标题年 + holiday-cn 上一自然年 ready 时，ensure/list 不得空转放行
// ---------------------------------------------------------------------------

test("N4: ensureYearForView does not treat holiday-cn previous year as a valid backfill", async () => {
  clearHolidayYears([2018, 2019]);
  // holiday-cn 2018 标题年数据：syntheticRaw(2018) 天然不含 2018-12-20 后的行。
  ingestHolidayYear(parseDataset("holiday-cn", syntheticRaw(2018)));
  // chinese-days 2019 单自然年数据：元旦只保留 2019-01-01，不含 2018-12 行。
  ingestHolidayYear(chineseDaysDataset(2019, false, true));

  let calls = 0;
  const fetch = async (): Promise<HolidayYearDataset> => {
    calls += 1;
    throw new Error("fetch must not be called");
  };
  await ensureYearForView(2019, {
    fetch,
    at: new Date("2025-08-15T00:00:00.000Z"),
  });
  assert.equal(calls, 0);
  // 上一自然年已 ready 但来源不匹配，视图缺口必须暴露为 undefined，而不是静默截断。
  assert.equal(holidayYearView(2019), undefined);
});

test("N4: holiday.list returns an error instead of a truncated view for the mixed-source gap", async () => {
  clearHolidayYears([2018, 2019]);
  ingestHolidayYear(parseDataset("holiday-cn", syntheticRaw(2018)));
  ingestHolidayYear(chineseDaysDataset(2019, false, true));

  const result = await tool("list").handler({ year: 2019 }, profile);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /2019 年节假日安排尚未获取/);
});

// ---------------------------------------------------------------------------
// H2：holiday.next 的 from 必须通过真实日历校验
// ---------------------------------------------------------------------------

test("H2: holiday.next rejects calendar-invalid from dates", async () => {
  const result = await tool("next").handler({ from: "2026-02-30" }, profile);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /from must be a valid calendar date/);
});

// ---------------------------------------------------------------------------
// H7：MCP 查询补到数据后立即重算 workday/holiday 日程
// ---------------------------------------------------------------------------

function h7Year(offset: number): number {
  // 选择真实当前年之后的年份，避免 createSchedule 的真实时间扫描与固定年冲突。
  return DateTime.now().setZone("Asia/Shanghai").year + 3 + offset;
}

test("H7: list 查询路径补到数据后立即 reconcile 受影响 workday 日程", async () => {
  const targetYear = h7Year(0);
  clearHolidayYears([targetYear, targetYear - 1]);
  const item = createSchedule(profile, {
    title: "H7 list workday",
    calendar: "solar",
    date: `${targetYear}-01-01`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  });
  assert.equal(item.enabled, false);

  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    if (year === targetYear) return parseDataset("holiday-cn", syntheticRaw(targetYear));
    throw new Error(`unexpected fetch for year ${year}`);
  };
  await ensureYearForView(targetYear, {
    fetch,
    at: new Date(`${targetYear - 1}-06-01T00:00:00.000Z`),
  });

  const after = getSchedule(profile, item.id);
  assert.equal(after.enabled, true);
  assert.ok(after.nextRunAt);
});

test("H7: is_workday 查询路径补到数据后立即 reconcile 受影响 workday 日程", async () => {
  const targetYear = h7Year(1);
  clearHolidayYears([targetYear, targetYear - 1]);
  const item = createSchedule(profile, {
    title: "H7 is_workday workday",
    calendar: "solar",
    date: `${targetYear}-01-01`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  });
  assert.equal(item.enabled, false);

  const fetch = async (year: number): Promise<HolidayYearDataset> => {
    if (year === targetYear) return parseDataset("holiday-cn", syntheticRaw(targetYear));
    throw new Error(`unexpected fetch for year ${year}`);
  };
  await ensureDayCoverage(`${targetYear}-01-01`, {
    fetch,
    at: new Date(`${targetYear - 1}-06-01T00:00:00.000Z`),
  });

  const after = getSchedule(profile, item.id);
  assert.equal(after.enabled, true);
  assert.ok(after.nextRunAt);
});

test("H7: 已 ready 的查询路径不触发全表 reconcile", async () => {
  const targetYear = h7Year(2);
  clearHolidayYears([targetYear, targetYear - 1]);
  const item = createSchedule(profile, {
    title: "H7 no reconcile workday",
    calendar: "solar",
    date: `${targetYear}-01-01`,
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "workday",
  });
  assert.equal(item.enabled, false);

  // 直接入库但不 reconcile：模拟“年份已 ready，只是日程尚未收敛”的场景。
  ingestHolidayYear(parseDataset("holiday-cn", syntheticRaw(targetYear)));
  let calls = 0;
  const fetch = async (): Promise<HolidayYearDataset> => {
    calls += 1;
    throw new Error("fetch must not be called");
  };
  await ensureDayCoverage(`${targetYear}-01-01`, {
    fetch,
    at: new Date(`${targetYear - 1}-06-01T00:00:00.000Z`),
  });
  assert.equal(calls, 0);
  // 已 ready 查询不得顺带做全表 reconcile：该日程应保持原状。
  assert.equal(getSchedule(profile, item.id).enabled, false);
});
