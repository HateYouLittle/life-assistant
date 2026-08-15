import crypto from "node:crypto";
import { DateTime } from "luxon";
import { httpJson as defaultHttpJson } from "../../core/http.js";

type HttpJson = (url: string) => Promise<unknown>;

export type HolidayDayType = "holiday" | "workday";

export interface HolidayDay {
  /** YYYY-MM-DD，按 Asia/Shanghai 日历日 */
  date: string;
  year: number;
  dayType: HolidayDayType;
  /** 节日名，如 元旦/春节/清明/劳动节/端午/中秋/国庆 */
  name: string;
}

export type HolidayDataSource = "holiday-cn" | "chinese-days";

export interface HolidayYearDataset {
  year: number;
  days: HolidayDay[];
  source: HolidayDataSource;
  officialPapers: string[];
  payloadHash: string;
}

export interface FetchHolidayYearOptions {
  httpJson?: HttpJson;
  /** 允许使用独立兜底源 chinese-days；次年（year > 当前年）抓取应传 false，避免入库非官方预估数据。 */
  allowFallback?: boolean;
  /** 要求主源携带国务院通知原文链接（官方已正式发布的证明）。 */
  requireOfficialPapers?: boolean;
}

const CHINA_ZONE = "Asia/Shanghai";
const VALID_HOLIDAY_NAMES = ["元旦", "春节", "清明", "劳动节", "端午", "中秋", "国庆"] as const;

/**
 * 法定节假日之外的「特殊假日」名称集合（如 2015 抗战胜利 70 周年纪念日）。
 * 七个法定节日仍保持强制齐全语义；特殊假日单独做「休假 + 调休上班日」成对校验。
 */
const SPECIAL_HOLIDAY_NAMES = ["抗日战争暨世界反法西斯战争胜利70周年纪念日"] as const;

/** 官方中秋与国庆合并放假的年份（chinese-days 兜底源可能只写「国庆节」）。 */
const MID_AUTUMN_NATIONAL_MERGED_YEARS = new Set([2020]);

/** 特殊假日的合理日期窗口与总天数上限（2015 仅 9 月）。 */
const SPECIAL_HOLIDAY_WINDOWS: ReadonlyArray<{ name: string; from: [number, number]; to: [number, number] }> = [
  { name: "抗日战争暨世界反法西斯战争胜利70周年纪念日", from: [9, 1], to: [9, 30] },
];
const MAX_SPECIAL_HOLIDAY_TOTAL_DAYS = 10;

/** 每个法定节日的休假日允许出现的日历窗口（拦截错位数据）。 */
const HOLIDAY_WINDOWS: ReadonlyArray<{ name: string; from: [number, number]; to: [number, number] }> = [
  { name: "元旦", from: [12, 20], to: [1, 10] },
  { name: "春节", from: [1, 10], to: [3, 10] },
  { name: "清明", from: [4, 1], to: [4, 15] },
  { name: "劳动节", from: [4, 20], to: [5, 12] },
  { name: "端午", from: [5, 20], to: [7, 10] },
  { name: "中秋", from: [9, 1], to: [11, 10] },
  { name: "国庆", from: [9, 20], to: [10, 20] },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 仅接受 http/https 且 hostname 为 www.gov.cn 或以 .gov.cn 结尾的官方通知链接。 */
function isGovCnPaperUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "www.gov.cn" || url.hostname.endsWith(".gov.cn");
  } catch {
    return false;
  }
}

function primaryUrl(year: number): string {
  return `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`;
}

function primaryRawUrl(year: number): string {
  return `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
}

function fallbackUrl(year: number): string {
  return `https://cdn.jsdelivr.net/npm/chinese-days/dist/years/${year}.json`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function parseHolidayCn(raw: unknown): HolidayYearDataset {
  const candidate = raw as Record<string, unknown>;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("holiday-cn response must be an object");
  }
  if (!Number.isInteger(candidate.year)) throw new Error("holiday-cn year must be an integer");
  const year = candidate.year as number;
  if (!Array.isArray(candidate.days)) throw new Error("holiday-cn days must be an array");
  const days: HolidayDay[] = [];
  for (const entry of candidate.days as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("holiday-cn day entry must be an object");
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) throw new Error("holiday-cn day name must be a non-empty string");
    if (typeof entry.date !== "string" || !DATE_RE.test(entry.date)) throw new Error("holiday-cn day date must be YYYY-MM-DD");
    if (typeof entry.isOffDay !== "boolean") throw new Error("holiday-cn day isOffDay must be a boolean");
    if (entry.isOffDay === false) {
      // 2020 疫情复工等场景会把普通周一（如 2020-02-03）标成 isOffDay:false。
      // 那只是「工作日」标记而非调休上班日：dayInfo 对周内日期默认就是工作日，
      // 因此仅保留周末调休上班日；日历非法的条目留给 validateHolidayYear 拒绝。
      const parsed = DateTime.fromISO(entry.date, { zone: CHINA_ZONE });
      if (parsed.isValid && parsed.toISODate() === entry.date && parsed.weekday < 6) continue;
    }
    days.push({
      date: entry.date,
      year: Number(entry.date.slice(0, 4)),
      dayType: entry.isOffDay ? "holiday" : "workday",
      name: entry.name.trim(),
    });
  }
  const papers = Array.isArray(candidate.papers)
    ? candidate.papers.filter((paper): paper is string =>
      typeof paper === "string" && paper.length > 0 && isGovCnPaperUrl(paper))
    : [];
  return {
    year,
    days,
    source: "holiday-cn",
    officialPapers: papers,
    payloadHash: sha256(JSON.stringify(raw)),
  };
}

export function parseChineseDays(raw: unknown): HolidayYearDataset {
  const candidate = raw as Record<string, unknown>;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("chinese-days response must be an object");
  }
  const parseMap = (value: unknown, dayType: HolidayDayType): HolidayDay[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("chinese-days day map must be an object");
    }
    const days: HolidayDay[] = [];
    for (const [date, rawName] of Object.entries(value as Record<string, unknown>)) {
      if (!DATE_RE.test(date)) throw new Error(`chinese-days date must be YYYY-MM-DD: ${date}`);
      if (typeof rawName !== "string" || !rawName.trim()) {
        throw new Error("chinese-days day value must be a non-empty string");
      }
      // 格式：English Name,中文名,类型码（类型码未使用）
      const name = rawName.split(",").map((part) => part.trim()).find((part) => part.length > 0 && /[\u4e00-\u9fff]/.test(part));
      if (!name) throw new Error(`chinese-days day value has no Chinese name: ${rawName}`);
      days.push({ date, year: Number(date.slice(0, 4)), dayType, name });
    }
    return days;
  };
  const days = [
    ...parseMap(candidate.holidays, "holiday"),
    ...parseMap(candidate.workdays, "workday"),
  ];
  const year = new Set(days.map((day) => day.year));
  if (year.size !== 1) throw new Error("chinese-days dataset must contain exactly one calendar year");
  return {
    year: [...year][0],
    days,
    source: "chinese-days",
    officialPapers: [],
    payloadHash: sha256(JSON.stringify(raw)),
  };
}

function monthDay(value: string): [number, number] {
  return [Number(value.slice(5, 7)), Number(value.slice(8, 10))];
}

function inWindow(value: string, from: [number, number], to: [number, number]): boolean {
  const [month, day] = monthDay(value);
  // 仅元旦窗口跨年；其余窗口 from <= to 单调。这里统一用起点 <= 终点判断，
  // 元旦特殊处理为「12月20日之后 或 1月10日之前」。
  if (from[0] > to[0]) {
    return (month > from[0] || (month === from[0] && day >= from[1]))
      || (month < to[0] || (month === to[0] && day <= to[1]));
  }
  const fromValue = from[0] * 100 + from[1];
  const toValue = to[0] * 100 + to[1];
  const dayValue = month * 100 + day;
  return dayValue >= fromValue && dayValue <= toValue;
}

function nameHits(value: string): string[] {
  return [...VALID_HOLIDAY_NAMES, ...SPECIAL_HOLIDAY_NAMES].filter((name) => value.includes(name));
}

/** 判断名称是否包含任一法定节日名或特殊假日名（供 calendar 关联调休上班日）。 */
export function holidayNameHits(value: string): string[] {
  return nameHits(value);
}

function specialNameHits(value: string): string[] {
  return SPECIAL_HOLIDAY_NAMES.filter((name) => value.includes(name));
}

function isWeekend(value: string): boolean {
  const weekday = DateTime.fromISO(value, { zone: CHINA_ZONE }).weekday; // 1=Mon ... 6=Sat 7=Sun
  return weekday === 6 || weekday === 7;
}

/** 结构校验：全部通过才允许入库。校验失败抛错并附原因。 */
export function validateHolidayYear(dataset: HolidayYearDataset): void {
  // 2004-2007 只有元旦/春节/劳动节/国庆四类法定假期；清明/端午/中秋自 2008 年起法定。
  const requiredNames = dataset.year >= 2008
    ? VALID_HOLIDAY_NAMES
    : (["元旦", "春节", "劳动节", "国庆"] as const);
  // 2008 年前为黄金周制度：真实年总休假日 ≥ 20（2004=22、2007≈24），
  // 与 2008 年后同下限，避免放过「每节 2 天共 8 天」这类明显残缺数据。
  const minHolidayDays = 20;
  const byDate = new Map<string, HolidayDay>();
  for (const day of dataset.days) {
    if (!DATE_RE.test(day.date)) throw new Error(`invalid calendar date: ${day.date}`);
    // 格式合法 ≠ 日历合法：拒绝 2025-02-30 这类真实历法中不存在的日期，
    // 同时用 toISODate() 回写比对拒绝 2025-2-3 这类非规范写法。
    const calendarDate = DateTime.fromISO(day.date, { zone: CHINA_ZONE });
    if (!calendarDate.isValid || calendarDate.toISODate() !== day.date) {
      throw new Error(`invalid calendar date: ${day.date}`);
    }
    // holiday-cn 年文件按国务院文件标题年份命名：跨年元旦会包含上一年 12 月下旬日期。
    // 仅放行「上一年 12/20 之后的元旦」这一合法形态；其余跨年日期（含 +1 年）一律拒绝，
    // 保留既有「整体年份错位必须拒绝」的校验能力。
    const [previousMonth, previousDay] = monthDay(day.date);
    const isPreviousYearNewYear = day.year === dataset.year - 1
      && nameHits(day.name).includes("元旦")
      && previousMonth === 12
      && previousDay >= 20;
    if (day.year !== dataset.year && !isPreviousYearNewYear) {
      throw new Error(`holiday date year ${day.year} != dataset year ${dataset.year}`);
    }
    if (day.dayType !== "holiday" && day.dayType !== "workday") throw new Error(`invalid holiday day type: ${day.dayType}`);
    if (!day.name.trim() || nameHits(day.name).length === 0) throw new Error(`unknown holiday name: ${day.name}`);
    if (byDate.has(day.date)) throw new Error(`duplicate holiday date: ${day.date}`);
    byDate.set(day.date, day);
  }
  if (byDate.size === 0) throw new Error("holiday dataset is empty");

  const holidayDays = dataset.days.filter((day) => day.dayType === "holiday");
  const workDays = dataset.days.filter((day) => day.dayType === "workday");
  const names = new Set<string>();
  for (const day of holidayDays) {
    for (const hit of nameHits(day.name)) names.add(hit);
    const hit = nameHits(day.name);
    if (!hit.some((name) =>
      HOLIDAY_WINDOWS.some((window) => window.name === name && inWindow(day.date, window.from, window.to))
      || SPECIAL_HOLIDAY_WINDOWS.some((window) => window.name === name && inWindow(day.date, window.from, window.to)))) {
      throw new Error(`holiday date outside legal window: ${day.date} (${day.name})`);
    }
  }
  // chinese-days 兜底源在官方中秋国庆合并放假年可能只写「国庆节」：
  // 仅当数据集中确有「国庆」且年份为官方合并年时，把「中秋」视为已满足。
  const midAutumnAliasSatisfied = dataset.source === "chinese-days"
    && MID_AUTUMN_NATIONAL_MERGED_YEARS.has(dataset.year)
    && names.has("国庆");
  for (const expected of requiredNames) {
    if (!names.has(expected) && !(expected === "中秋" && midAutumnAliasSatisfied)) {
      throw new Error(`holiday dataset is missing statutory holiday: ${expected}`);
    }
  }
  for (const day of workDays) {
    if (!isWeekend(day.date)) throw new Error(`make-up workday must be a weekend: ${day.date}`);
    if (nameHits(day.name).length === 0) throw new Error(`make-up workday has unknown name: ${day.name}`);
  }
  const holidayCount = holidayDays.length;
  if (holidayCount < minHolidayDays || holidayCount > 45) {
    throw new Error(`unexpected holiday day count: ${holidayCount} (expected ${minHolidayDays}-45)`);
  }
  if (workDays.length > 12) throw new Error(`unexpected make-up workday count: ${workDays.length}`);

  // 特殊假日必须同时包含休假与调休上班日、总天数有限、且全部落在合理日期窗口内。
  for (const special of SPECIAL_HOLIDAY_NAMES) {
    const specialDays = dataset.days.filter((day) => specialNameHits(day.name).includes(special));
    if (specialDays.length === 0) continue;
    const specialHolidayDays = specialDays.filter((day) => day.dayType === "holiday");
    const specialWorkDays = specialDays.filter((day) => day.dayType === "workday");
    if (specialHolidayDays.length === 0 || specialWorkDays.length === 0) {
      throw new Error(`special holiday ${special} must include both holiday and make-up workday days`);
    }
    if (specialDays.length > MAX_SPECIAL_HOLIDAY_TOTAL_DAYS) {
      throw new Error(`unexpected special holiday day count: ${specialDays.length}`);
    }
    const window = SPECIAL_HOLIDAY_WINDOWS.find((candidate) => candidate.name === special);
    for (const day of specialDays) {
      if (!window || !inWindow(day.date, window.from, window.to)) {
        throw new Error(`special holiday date outside legal window: ${day.date} (${day.name})`);
      }
    }
  }

  // 每个节日名的休息日必须按名字分组形成有限个连续段（官方安排每段连续）。
  const groups = new Map<string, number>();
  for (const name of VALID_HOLIDAY_NAMES) {
    const dates = holidayDays
      .filter((day) => nameHits(day.name).includes(name))
      .map((day) => day.date)
      .sort();
    if (dates.length === 0) continue;
    let runs = 1;
    for (let index = 1; index < dates.length; index += 1) {
      const previous = DateTime.fromISO(dates[index - 1], { zone: CHINA_ZONE });
      const current = DateTime.fromISO(dates[index], { zone: CHINA_ZONE });
      if (current.diff(previous, "days").days !== 1) runs += 1;
    }
    groups.set(name, runs);
  }
  for (const [name, runs] of groups) {
    if (runs > 4) throw new Error(`holiday ${name} has too many disjoint periods: ${runs}`);
  }
}

export function parseDataset(source: HolidayDataSource, raw: unknown): HolidayYearDataset {
  const dataset = source === "holiday-cn" ? parseHolidayCn(raw) : parseChineseDays(raw);
  validateHolidayYear(dataset);
  return dataset;
}

/** 汇总错误信息时脱敏：错误不得包含 URL 或密钥。 */
function redactSensitiveError(value: string): string {
  return value
    .replace(/https?:\/\/[^\s);]+/gi, "<url>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<secret>");
}

/** 按序抓取并解析某年节假日数据：主源 CDN → 主源 raw 镜像 →（可选）chinese-days。 */
export async function fetchHolidayYear(
  year: number,
  options: FetchHolidayYearOptions = {},
): Promise<HolidayYearDataset> {
  if (!Number.isInteger(year) || year < 2004 || year > 2100) {
    throw new Error(`holiday year must be an integer between 2004 and 2100: ${year}`);
  }
  const httpJson = options.httpJson ?? (defaultHttpJson as HttpJson);
  const allowFallback = options.allowFallback ?? true;
  const requireOfficialPapers = options.requireOfficialPapers ?? false;
  const candidates: Array<{ source: HolidayDataSource; url: string }> = [
    { source: "holiday-cn", url: primaryUrl(year) },
    { source: "holiday-cn", url: primaryRawUrl(year) },
  ];
  if (allowFallback) candidates.push({ source: "chinese-days", url: fallbackUrl(year) });

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const raw = await httpJson(candidate.url);
      const dataset = parseDataset(candidate.source, raw);
      // 数据自洽 ≠ 数据正确：必须核对返回数据集年份与请求年份一致，
      // 否则错年数据会按日期自然年入库，meta 却把请求年份标 ready，破坏
      // 「无数据年份绝不按普通周历猜测」的核心保证。
      if (dataset.year !== year) {
        throw new Error(`holiday dataset year ${dataset.year} does not match requested year ${year}`);
      }
      if (requireOfficialPapers && (dataset.source !== "holiday-cn" || dataset.officialPapers.length === 0)) {
        throw new Error("primary source has no official State Council paper for this year");
      }
      return dataset;
    } catch (error) {
      errors.push(`${candidate.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const sanitized = errors.map(redactSensitiveError);
  throw new AggregateError(
    errors.map(redactSensitiveError),
    `failed to fetch official holiday arrangement for ${year} (${sanitized.join("; ")})`,
  );
}
