import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  fetchHolidayYear,
  parseChineseDays,
  parseDataset,
  parseHolidayCn,
  validateHolidayYear,
} from "../src/modules/holiday/provider.js";

const fixtures = path.join(process.cwd(), "tests", "fixtures");

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8")) as Record<string, unknown>;
}

const holidayCnRaw = readJson("holiday-cn-2025.json");
const chineseDaysRaw = readJson("chinese-days-2025.json");

test("holiday-cn fixture parses into normalized holiday/workday days", () => {
  const dataset = parseHolidayCn(holidayCnRaw);
  assert.equal(dataset.year, 2025);
  assert.equal(dataset.source, "holiday-cn");
  assert.ok(dataset.officialPapers.length > 0);
  const workdays = dataset.days.filter((day) => day.dayType === "workday");
  const holidays = dataset.days.filter((day) => day.dayType === "holiday");
  assert.ok(workdays.some((day) => day.date === "2025-01-26" && day.name === "春节"));
  assert.ok(holidays.some((day) => day.date === "2025-10-01"));
  assert.ok(dataset.days.every((day) => day.year === 2025));
  assert.equal(dataset.payloadHash.length, 64);
});

test("chinese-days fixture parses holiday and workday maps", () => {
  const dataset = parseChineseDays(chineseDaysRaw);
  assert.equal(dataset.year, 2025);
  assert.equal(dataset.source, "chinese-days");
  assert.ok(dataset.days.some((day) => day.date === "2025-02-08" && day.dayType === "workday" && day.name === "春节"));
  assert.ok(dataset.days.some((day) => day.date === "2025-10-06" && day.dayType === "holiday" && day.name === "中秋"));
});

test("both real datasets pass structural validation", () => {
  validateHolidayYear(parseHolidayCn(holidayCnRaw));
  validateHolidayYear(parseChineseDays(chineseDaysRaw));
});

test("primary source is fetched first and parsed", async () => {
  const calls: string[] = [];
  const httpJson = async (url: string): Promise<unknown> => {
    calls.push(url);
    return holidayCnRaw;
  };
  const dataset = await fetchHolidayYear(2025, { httpJson });
  assert.equal(dataset.source, "holiday-cn");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /NateScarlet\/holiday-cn/);
});

test("raw GitHub mirror covers a jsDelivr outage", async () => {
  const calls: string[] = [];
  const httpJson = async (url: string): Promise<unknown> => {
    calls.push(url);
    if (url.includes("cdn.jsdelivr.net")) throw new Error("HTTP 503");
    return holidayCnRaw;
  };
  const dataset = await fetchHolidayYear(2025, { httpJson });
  assert.equal(dataset.source, "holiday-cn");
  assert.deepEqual(calls.length, 2);
  assert.match(calls[1], /raw.githubusercontent.com/);
});

test("independent chinese-days source is used when primary mirrors fail", async () => {
  const calls: string[] = [];
  const httpJson = async (url: string): Promise<unknown> => {
    calls.push(url);
    if (url.includes("NateScarlet") || url.includes("raw.githubusercontent.com")) throw new Error("HTTP 503");
    return chineseDaysRaw;
  };
  const dataset = await fetchHolidayYear(2025, { httpJson });
  assert.equal(dataset.source, "chinese-days");
  assert.equal(calls.length, 3);
});

test("fetch fails with aggregate error when every source is unavailable", async () => {
  const httpJson = async (): Promise<unknown> => {
    throw new Error("network down");
  };
  await assert.rejects(() => fetchHolidayYear(2025, { httpJson }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    return true;
  });
});

test("allowFallback=false never contacts the chinese-days source", async () => {
  const calls: string[] = [];
  const httpJson = async (url: string): Promise<unknown> => {
    calls.push(url);
    throw new Error("HTTP 503");
  };
  await assert.rejects(() => fetchHolidayYear(2025, { httpJson, allowFallback: false }));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => !url.includes("chinese-days")));
});

test("future-year gate rejects datasets without official papers", async () => {
  const withoutPapers = { ...holidayCnRaw, papers: [] };
  const httpJson = async (): Promise<unknown> => withoutPapers;
  await assert.rejects(
    () => fetchHolidayYear(2026, { httpJson, allowFallback: false, requireOfficialPapers: true }),
    /failed to fetch official holiday arrangement/,
  );
});

test("future-year gate rejects the independent fallback even when it returns data", async () => {
  const httpJson = async (url: string): Promise<unknown> => {
    if (url.includes("NateScarlet") || url.includes("raw.githubusercontent.com")) throw new Error("HTTP 404");
    return chineseDaysRaw;
  };
  await assert.rejects(
    () => fetchHolidayYear(2026, { httpJson, requireOfficialPapers: true }),
    /failed to fetch official holiday arrangement/,
  );
});

test("validation rejects a missing statutory holiday", () => {
  const raw = structuredClone(holidayCnRaw) as { days: Array<Record<string, unknown>> };
  raw.days = raw.days.filter((day) => !String(day.name).includes("端午"));
  assert.throws(() => validateHolidayYear(parseHolidayCn(raw)), /missing statutory holiday: 端午/);
});

test("validation rejects make-up workdays that are not weekends", () => {
  const raw = structuredClone(holidayCnRaw) as { days: Array<Record<string, unknown>> };
  const workday = raw.days.find((day) => day.isOffDay === false && day.date === "2025-01-26") as Record<string, unknown>;
  workday.date = "2025-01-27"; // Monday
  assert.throws(() => validateHolidayYear(parseHolidayCn(raw)), /make-up workday must be a weekend/);
});

test("validation rejects holiday dates outside their legal window", () => {
  const raw = structuredClone(holidayCnRaw) as { days: Array<Record<string, unknown>> };
  const newYear = raw.days.find((day) => day.name === "元旦") as Record<string, unknown>;
  newYear.date = "2025-01-20";
  assert.throws(() => validateHolidayYear(parseHolidayCn(raw)), /outside legal window/);
});

test("validation rejects duplicate dates", () => {
  const raw = structuredClone(holidayCnRaw) as { days: Array<Record<string, unknown>> };
  raw.days.push({ name: "春节", date: "2025-01-28", isOffDay: true });
  assert.throws(() => validateHolidayYear(parseHolidayCn(raw)), /duplicate holiday date/);
});

test("validation rejects a year field that disagrees with day years", () => {
  const raw = structuredClone(holidayCnRaw) as Record<string, unknown>;
  raw.year = 2026;
  assert.throws(() => validateHolidayYear(parseHolidayCn(raw)), /year 2026 != dataset year|holiday date year/);
});

test("parseDataset dispatches by source", () => {
  assert.equal(parseDataset("holiday-cn", holidayCnRaw).source, "holiday-cn");
  assert.equal(parseDataset("chinese-days", chineseDaysRaw).source, "chinese-days");
});

// ---------------------------------------------------------------------------
// T1：fetchHolidayYear 必须核对请求年份与数据年份一致
// ---------------------------------------------------------------------------

function syntheticChineseDaysRaw(year: number): Record<string, unknown> {
  const groups: Array<[string, [number, number], number]> = [
    ["元旦", [1, 1], 3],
    ["春节", [2, 1], 8],
    ["清明节", [4, 4], 3],
    ["劳动节", [5, 1], 5],
    ["端午节", [6, 1], 3],
    ["中秋节", [9, 15], 3],
    ["国庆节", [10, 1], 7],
  ];
  const holidays: Record<string, string> = {};
  for (const [name, [month, day], length] of groups) {
    let cursor = new Date(Date.UTC(year, month - 1, day));
    for (let index = 0; index < length; index += 1) {
      const date = cursor.toISOString().slice(0, 10);
      holidays[date] = `Holiday,${name},1`;
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  return { holidays, workdays: {}, inLieuDays: {} };
}

function syntheticHolidayCnRaw(year: number): Record<string, unknown> {
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
    let cursor = new Date(Date.UTC(year, month - 1, day));
    for (let index = 0; index < length; index += 1) {
      days.push({ name, date: cursor.toISOString().slice(0, 10), isOffDay: true });
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  return { year, papers: [`https://www.gov.cn/zhengce/zhengceku/${year}/content_example.htm`], days };
}

test("T1: fetchHolidayYear rejects a response whose dataset year differs from the requested year", async () => {
  // 请求 2026 却返回 2025 年合法数据：数据自洽，但与请求年份不一致，必须拒绝。
  const httpJson = async (): Promise<unknown> => holidayCnRaw;
  await assert.rejects(
    () => fetchHolidayYear(2026, { httpJson, allowFallback: false }),
    /dataset year 2025 does not match requested year 2026|failed to fetch official holiday arrangement/,
  );
});

test("T1: fetchHolidayYear falls through to the fallback source when primary returns the wrong year", async () => {
  const calls: string[] = [];
  const httpJson = async (url: string): Promise<unknown> => {
    calls.push(url);
    if (url.includes("cdn.jsdelivr.net/gh/")) return holidayCnRaw; // 错年：2025 数据
    if (url.includes("raw.githubusercontent.com")) throw new Error("HTTP 503");
    return syntheticChineseDaysRaw(2026);
  };
  const dataset = await fetchHolidayYear(2026, { httpJson });
  assert.equal(dataset.source, "chinese-days");
  assert.equal(dataset.year, 2026);
  assert.equal(calls.length, 3);
});

// ---------------------------------------------------------------------------
// T2：历史年份与跨年元旦不得被误拒
// ---------------------------------------------------------------------------

test("T2a: 2004 four-holiday dataset passes historical validation", () => {
  const raw = readJson("holiday-cn-2004.json");
  const dataset = parseHolidayCn(raw);
  validateHolidayYear(dataset);
  // H3a：真实 2004 黄金周口径 = 22 个休假日 + 6 个周末补班日。
  assert.equal(dataset.days.filter((day) => day.dayType === "holiday").length, 22);
  assert.equal(dataset.days.filter((day) => day.dayType === "workday").length, 6);
});

test("H3b: pre-2008 datasets with only eight holiday days are rejected", () => {
  const raw = {
    year: 2004,
    papers: ["https://www.gov.cn/zhengce/zhengceku/2004/content_example.htm"],
    days: [
      { name: "元旦", date: "2004-01-01", isOffDay: true },
      { name: "元旦", date: "2004-01-02", isOffDay: true },
      { name: "春节", date: "2004-02-01", isOffDay: true },
      { name: "春节", date: "2004-02-02", isOffDay: true },
      { name: "劳动节", date: "2004-05-01", isOffDay: true },
      { name: "劳动节", date: "2004-05-02", isOffDay: true },
      { name: "国庆节", date: "2004-10-01", isOffDay: true },
      { name: "国庆节", date: "2004-10-02", isOffDay: true },
    ],
  };
  assert.throws(
    () => validateHolidayYear(parseHolidayCn(raw)),
    /unexpected holiday day count: 8 \(expected 20-45\)/,
  );
});

test("T2a: 2019 cross-year New Year dataset passes validation", () => {
  const dataset = parseHolidayCn(readJson("holiday-cn-2019.json"));
  validateHolidayYear(dataset);
  assert.ok(dataset.days.some((day) => day.date === "2018-12-30" && day.dayType === "holiday"));
  assert.ok(dataset.days.some((day) => day.date === "2018-12-29" && day.dayType === "workday"));
});

test("T2b: datasets from 2008 onward still require all seven statutory holidays", () => {
  const raw = {
    year: 2008,
    papers: ["https://www.gov.cn/zhengce/zhengceku/2008/content_example.htm"],
    days: [
      { name: "元旦", date: "2008-01-01", isOffDay: true },
      { name: "春节", date: "2008-02-06", isOffDay: true },
      { name: "春节", date: "2008-02-07", isOffDay: true },
      { name: "春节", date: "2008-02-08", isOffDay: true },
      { name: "劳动节", date: "2008-05-01", isOffDay: true },
      { name: "劳动节", date: "2008-05-02", isOffDay: true },
      { name: "劳动节", date: "2008-05-03", isOffDay: true },
      { name: "国庆节", date: "2008-10-01", isOffDay: true },
      { name: "国庆节", date: "2008-10-02", isOffDay: true },
      { name: "国庆节", date: "2008-10-03", isOffDay: true },
    ],
  };
  assert.throws(() => validateHolidayYear(parseHolidayCn(raw)), /missing statutory holiday: 清明/);
});

test("T2a: datasets reject dates from the following calendar year", () => {
  const raw = structuredClone(readJson("holiday-cn-2019.json")) as { days: Array<Record<string, unknown>> };
  raw.days.push({ name: "元旦", date: "2020-01-01", isOffDay: true });
  assert.throws(() => validateHolidayYear(parseHolidayCn(raw)), /holiday date year 2020/);
});

// ---------------------------------------------------------------------------
// T3：日期合法性必须做真实日历校验，不能只靠格式正则
// ---------------------------------------------------------------------------

test("T3: validation rejects calendar-invalid dates", () => {
  const base = parseHolidayCn(holidayCnRaw);
  for (const bad of ["2025-02-30", "2025-13-01", "2025-00-10", "2025-2-3", "2025-02-29"]) {
    const mutated = {
      ...base,
      days: [...base.days, { date: bad, year: 2025, dayType: "holiday" as const, name: "春节" }],
    };
    assert.throws(() => validateHolidayYear(mutated), /invalid calendar date/, `expected ${bad} to be rejected`);
  }
});

test("T3: validation accepts a valid in-window calendar date", () => {
  const base = parseHolidayCn(holidayCnRaw);
  const mutated = {
    ...base,
    days: [...base.days, { date: "2025-02-28", year: 2025, dayType: "holiday" as const, name: "春节" }],
  };
  assert.doesNotThrow(() => validateHolidayYear(mutated));
});

test("H4: leap-year boundary dates are accepted or rejected correctly", () => {
  // 2025 非闰年：2025-02-29 已在 T3 坏日期列表中断言拒绝。
  // 2024 闰年：2024-02-29 必须通过完整 parseDataset/validateHolidayYear。
  const base2024 = parseHolidayCn(syntheticHolidayCnRaw(2024));
  const withLeapDay = {
    ...base2024,
    days: [...base2024.days, { date: "2024-02-29", year: 2024, dayType: "holiday" as const, name: "春节" }],
  };
  assert.doesNotThrow(() => validateHolidayYear(withLeapDay));
});

// ---------------------------------------------------------------------------
// H5：chinese-days 必须保持「恰好一个自然年」行为，并锁定抓取链的错误聚合
// ---------------------------------------------------------------------------

test("H5: parseChineseDays rejects data spanning two natural years", () => {
  const raw = {
    holidays: {
      "2024-12-30": "Holiday,元旦,1",
      "2025-01-01": "Holiday,元旦,1",
    },
    workdays: {},
    inLieuDays: {},
  };
  assert.throws(() => parseChineseDays(raw), /exactly one calendar year/);
});

test("H5: fetchHolidayYear aggregates a mixed-year chinese-days fallback failure", async () => {
  const mixed = {
    holidays: {
      "2024-12-30": "Holiday,元旦,1",
      "2025-01-01": "Holiday,元旦,1",
    },
    workdays: {},
    inLieuDays: {},
  };
  const httpJson = async (url: string): Promise<unknown> => {
    if (url.includes("NateScarlet") || url.includes("raw.githubusercontent.com")) {
      throw new Error("HTTP 503");
    }
    return mixed;
  };
  await assert.rejects(() => fetchHolidayYear(2025, { httpJson }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    assert.ok(error.errors.some((entry) => String(entry).includes("exactly one calendar year")));
    return true;
  });
});
