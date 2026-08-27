import { z } from "zod";
import { DateTime } from "luxon";
import { config } from "../../config.js";
import { registerModule, ok, fail, withTool, type AssistantModule } from "../../core/registry.js";
import { reconcileHolidaySchedules } from "../schedule/service.js";
import type { FetchHolidayYearOptions, HolidayYearDataset } from "./provider.js";
import {
  CHINA_ZONE,
  dayInfo,
  ensureHolidayYear,
  holidayYearView,
  nextHoliday,
  readHolidayYear,
  refreshHolidayCalendar,
  yearStatus,
} from "./calendar.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localYear(at = new Date()): number {
  return DateTime.fromJSDate(at, { zone: CHINA_ZONE }).year;
}

export interface QueryFetchOptions {
  fetch?: (year: number, options?: FetchHolidayYearOptions) => Promise<HolidayYearDataset>;
  at?: Date;
}

/** 查询工具遇到缺数据时的补齐门槛：当年/历史年可走兜底源，未来年只走官方主源。 */
async function ensureYear(year: number, at: Date, fetch?: QueryFetchOptions["fetch"]): Promise<void> {
  await ensureHolidayYear(year, {
    at,
    allowFallback: year <= localYear(at),
    requireOfficialPapers: year > localYear(at),
    fetch,
  });
}

/** 若调用前未 ready 的年份在本轮确实补到了数据，则重算一次 workday/holiday 日程。 */
function reconcileIfYearsBecameReady(notReadyBefore: ReadonlySet<number>): void {
  for (const year of notReadyBefore) {
    if (yearStatus(year)?.ready === true) {
      reconcileHolidaySchedules();
      return;
    }
  }
}

/** list(year) 的保障：K1 方案 A 下视图只依赖标题年 year 的文件，ensure year 即可；
 * 若 year 数据来自 chinese-days（单自然年），还需补齐 year-1 才能让视图的
 * 12/20-12/31 跨年段完整（N3）。 */
export async function ensureYearForView(
  year: number,
  options: QueryFetchOptions = {},
): Promise<void> {
  const at = options.at ?? new Date();
  const notReadyBefore = new Set<number>();
  if (!readHolidayYear(year)) notReadyBefore.add(year);
  if (notReadyBefore.has(year)) await ensureYear(year, at, options.fetch);
  const status = yearStatus(year);
  if (status?.ready !== true || status.source !== "chinese-days" || year - 1 < 2004) {
    reconcileIfYearsBecameReady(notReadyBefore);
    return;
  }
  // 跨年段只能由 year-1 的 chinese-days 自然年文件提供：
  // - year-1 未 ready → 尝试补抓（主链仍可能拿到 holiday-cn，拿不到跨年行）；
  // - year-1 已 ready 但 source 不是 chinese-days（如 holiday-cn）→ 不覆盖既有数据，
  //   由视图层判定缺口并返回 undefined，list 经 viewOrFail 报错呈现（N4）。
  const prev = yearStatus(year - 1);
  if (prev?.ready !== true) {
    notReadyBefore.add(year - 1);
    await ensureYear(year - 1, at, options.fetch);
  }
  reconcileIfYearsBecameReady(notReadyBefore);
}

/**
 * is_workday(target) 的保障：12/20-12/31 的自然年日期属于「下一年标题年」的
 * 元旦跨年段，权威数据在 year+1 文件；优先确保下一年，失败再尝试自然年
 * （chinese-days 单自然年文件也可能覆盖该日期）。任一 ready 即按日期直查表。
 */
export async function ensureDayCoverage(
  target: string,
  options: QueryFetchOptions = {},
): Promise<void> {
  const at = options.at ?? new Date();
  const year = Number(target.slice(0, 4));
  const inCrossYearWindow = target.slice(5, 10) >= "12-20";
  const candidates = inCrossYearWindow ? [year + 1, year] : [year];
  const notReadyBefore = new Set(candidates.filter((candidate) => !readHolidayYear(candidate)));
  let lastError: unknown;
  for (const candidate of candidates) {
    if (!readHolidayYear(candidate)) {
      try {
        await ensureYear(candidate, at, options.fetch);
      } catch (error) {
        lastError = error;
        continue;
      }
    }
    if (!inCrossYearWindow) {
      reconcileIfYearsBecameReady(notReadyBefore);
      return;
    }
    // 跨年窗口：仅 holiday-cn 的 year+1 标题年文件完整覆盖该窗口，ready 即视为
    // 覆盖（目标无行时 dayInfo 的普通周历兜底正确）；chinese-days 是单自然年
    // 数据，year+1 不含目标日期行，必须继续回退自然年 year 并做行命中确认。
    if (candidate === year + 1 && yearStatus(candidate)?.source === "holiday-cn") {
      reconcileIfYearsBecameReady(notReadyBefore);
      return;
    }
    if (candidate === year + 1) continue;
    const info = dayInfo(target);
    if (info && (info.dayType === "holiday" || info.dayType === "workday")) {
      reconcileIfYearsBecameReady(notReadyBefore);
      return;
    }
  }
  reconcileIfYearsBecameReady(notReadyBefore);
  if (lastError !== undefined) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  throw new Error(
    `目标日期 ${target} 所属标题年（${year + 1}）的节假日数据缺失，无法判断该日类型`,
  );
}

function viewOrFail(year: number) {
  const view = holidayYearView(year);
  if (!view) throw new Error(`${year} 年节假日安排尚未获取，请稍后重试或使用 holiday.refresh 补抓。`);
  return view;
}

export async function runHolidayRefresh(): Promise<void> {
  await refreshHolidayCalendar();
  // 每日兜底重算：即使没有新数据入库，也修复此前未收敛的 workday/holiday 日程派生状态。
  reconcileHolidaySchedules();
}

const holidayModule: AssistantModule = {
  name: "holiday",
  tools: [
    withTool(
      {
        name: "next",
        description: "查询距离下一次中国大陆法定节假日放假还有多少天。返回节日名、放假起止日期、倒计时天数及该假期的调休上班日；若正在假期中会返回 ongoing 与剩余天数。",
      },
      { from: z.string().regex(DATE_RE, "from must be YYYY-MM-DD").optional().describe("可选，按该日期（Asia/Shanghai）计算，默认今天") },
      async ({ from }) => {
        if (from !== undefined) {
          const parsed = DateTime.fromISO(from, { zone: CHINA_ZONE });
          if (!parsed.isValid || parsed.toISODate() !== from) {
            return fail("from must be a valid calendar date");
          }
        }
        const at = from
          ? DateTime.fromISO(from, { zone: CHINA_ZONE }).startOf("day").toJSDate()
          : new Date();
        return ok(nextHoliday(at));
      },
    ),
    withTool(
      {
        name: "list",
        description: "查询指定年份的中国大陆法定节假日安排：所有连休期（起止日期、天数、调休上班日）及该年全部调休上班日。数据缺失时会自动向官方数据源补齐。",
      },
      { year: z.number().int().min(2004).max(2100) },
      async ({ year }) => {
        await ensureYearForView(year);
        return ok(viewOrFail(year));
      },
    ),
    withTool(
      {
        name: "is_workday",
        description: "判断某一天是否为中国大陆法定工作日。会考虑法定节假日与调休上班日；缺省判断今天。返回 isWorkday、dayType（workday/holiday/weekend/weekday）与节日名/补班说明。",
      },
      { date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD").optional().describe("可选，默认今天（Asia/Shanghai）") },
      async ({ date }) => {
        const target = date ?? DateTime.fromJSDate(new Date(), { zone: CHINA_ZONE }).toISODate();
        if (!target) throw new Error("invalid date");
        await ensureDayCoverage(target);
        const info = dayInfo(target);
        if (!info) throw new Error(`invalid date: ${target}`);
        return ok(info);
      },
    ),
    withTool(
      {
        name: "refresh",
        description: "手动触发补抓指定年份（默认当年）的中国大陆法定节假日安排并重算受影响的 workday/holiday 日程；force=true 会跳过失败冷却立即重试。数据仍来自官方数据源。",
      },
      {
        year: z.number().int().min(2004).max(2100).optional(),
        force: z.boolean().optional(),
      },
      async ({ year, force }) => {
        const targetYear = year ?? localYear();
        const record = await ensureHolidayYear(targetYear, {
          allowFallback: targetYear <= localYear(),
          requireOfficialPapers: targetYear > localYear(),
          cooldownMs: force ? 0 : undefined,
        });
        const summary = reconcileHolidaySchedules();
        return ok({
          fetched: true,
          year: record.year,
          source: record.source,
          fetchedAt: record.fetchedAt,
          days: record.days.length,
          scheduleReconcile: summary,
        });
      },
    ),
  ],
  jobs: [
    {
      name: "refresh_calendar",
      cron: config.cron.holidayRefresh,
      timezone: CHINA_ZONE,
      handler: async () => runHolidayRefresh(),
    },
  ],
  onStart: async () => {
    // 启动引导：确保当年数据可用，并重算 workday/holiday 日程派生状态。
    await refreshHolidayCalendar();
    reconcileHolidaySchedules();
  },
};

registerModule(holidayModule);

export { holidayYearView, nextHoliday, readHolidayYear, yearStatus };
