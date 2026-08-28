import { DateTime } from "luxon";
import { getDatabase } from "../../core/database.js";
import {
  fetchHolidayYear as defaultFetchHolidayYear,
  holidayNameHits,
  validateHolidayYear,
  type FetchHolidayYearOptions,
  type HolidayDay,
  type HolidayDayType,
  type HolidayYearDataset,
} from "./provider.js";

export const CHINA_ZONE = "Asia/Shanghai";
export const DEFAULT_ATTEMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** 标题年视图覆盖窗口：上一年 12/20 起（含跨年元旦段），本标题年 12/19 止（不含 12 月下旬外发行）。 */
export const YEAR_VIEW_COVERAGE_START = "12-20";
export const YEAR_VIEW_COVERAGE_END = "12-19";

export interface HolidayYearRecord {
  year: number;
  source: string;
  fetchedAt: string;
  payloadHash: string;
  days: HolidayDay[];
}

export interface YearStatus {
  year: number;
  ready: boolean;
  source?: string;
  fetchedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface MakeUpWorkday {
  date: string;
  name: string;
}

export interface HolidayPeriod {
  /** 该连休期涉及的全部节日名（去重，按出现顺序）。 */
  name: string;
  startDate: string;
  endDate: string;
  days: number;
  makeUpWorkdays: MakeUpWorkday[];
}

export interface HolidayYearView {
  year: number;
  periods: HolidayPeriod[];
  workdays: MakeUpWorkday[];
}

export interface NextHolidayResult {
  status: "ongoing" | "upcoming" | "unknown";
  today: string;
  holidayName?: string;
  startDate?: string;
  endDate?: string;
  days?: number;
  countdownDays?: number;
  remainingDays?: number;
  makeUpWorkdays?: MakeUpWorkday[];
  /** 已覆盖数据的最晚年份末；unknown 时帮助说明边界。 */
  coveredUntil?: string;
  message?: string;
}

export interface RefreshHolidayCalendarOptions {
  fetch?: (year: number, options?: FetchHolidayYearOptions) => Promise<HolidayYearDataset>;
  cooldownMs?: number;
  at?: Date;
}

export interface RefreshHolidayCalendarResult {
  at: string;
  years: number[];
  fetched: HolidayYearRecord[];
  skipped: Array<{ year: number; error: string }>;
}

interface MetaRow {
  year: number;
  status: string;
  source: string;
  payload_hash: string;
  fetched_at: string;
  last_attempt_at: string | null;
  last_error: string | null;
}

function metaRow(year: number): MetaRow | undefined {
  return getDatabase().prepare(
    "SELECT * FROM cn_holiday_year_meta WHERE year = ?",
  ).get(year) as MetaRow | undefined;
}

export function yearStatus(year: number): YearStatus | undefined {
  const row = metaRow(year);
  if (!row) return undefined;
  return {
    year: row.year,
    ready: row.status === "ready",
    source: row.source,
    fetchedAt: row.fetched_at,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

export function isHolidayYearReady(year: number): boolean {
  return yearStatus(year)?.ready === true;
}

/**
 * 某日历日是否属于「有权威节假日数据覆盖」的标题年区间：
 * - 12/20-12/31 的自然年日期属于 year+1 标题年的元旦跨年段：year+1 ready 即覆盖；
 *   若 year+1 未 ready，只有自然年 year ready 且该日期命中权威行（holiday/workday）
 *   才算覆盖（chinese-days 单自然年文件可能含该行）；
 * - 其余日期属于自然年 year 标题年：year ready 即覆盖，无行时按普通周历是正确兜底。
 * 调用方凭此决定「可继续扫描/按周历处理」还是「无数据区间，返回 null」。
 */
export function isDateCoveredByHolidayData(date: string): boolean {
  const year = Number(date.slice(0, 4));
  if (date.slice(5, 10) < YEAR_VIEW_COVERAGE_START) return isHolidayYearReady(year);
  // 12/20-12/31 属于 year+1 标题年：仅 holiday-cn 的标题年文件完整覆盖该窗口；
  // chinese-days 是单自然年数据，year+1 文件不含上一年 12 月行，不能视为覆盖。
  const nextStatus = yearStatus(year + 1);
  if (nextStatus?.ready === true && nextStatus.source === "holiday-cn") return true;
  if (!isHolidayYearReady(year)) return false;
  const info = dayInfo(date);
  return info?.dayType === "holiday" || info?.dayType === "workday";
}

/** 读取某年已入库数据（未 ready 返回 undefined）。按标题年日期范围计数，
 * 与 holidayYearView 收窄后的语义一致：含上一年 12/20 后的跨年元旦行，
 * 不含下一年标题年写入的本年 12 月下旬行。 */
export function readHolidayYear(year: number): HolidayYearRecord | undefined {
  const meta = yearStatus(year);
  if (!meta?.ready) return undefined;
  const minDate = `${year - 1}-${YEAR_VIEW_COVERAGE_START}`;
  const maxDate = `${year}-${YEAR_VIEW_COVERAGE_END}`;
  const rows = getDatabase().prepare(
    "SELECT date, year, day_type, name FROM cn_holiday_days WHERE date >= ? AND date <= ? ORDER BY date",
  ).all(minDate, maxDate) as Array<{ date: string; year: number; day_type: HolidayDayType; name: string }>;
  return {
    year,
    source: meta.source!,
    fetchedAt: meta.fetchedAt!,
    payloadHash: metaRow(year)?.payload_hash ?? "",
    days: rows.map((row) => ({ date: row.date, year: row.year, dayType: row.day_type, name: row.name })),
  };
}

export interface DayInfo {
  date: string;
  isWorkday: boolean;
  isHoliday: boolean;
  dayType: "holiday" | "workday" | "weekend" | "weekday";
  name?: string;
  note?: string;
}

/**
 * 分类单个日历日。调用方必须先确认该年 ready（否则会把未覆盖年份误判为普通周历）；
 * date 非法时返回 null。
 */
export function dayInfo(date: string): DayInfo | null {
  const parsed = DateTime.fromISO(date, { zone: CHINA_ZONE });
  if (!parsed.isValid || parsed.toISODate() !== date) return null;
  const row = getDatabase().prepare(
    "SELECT day_type, name FROM cn_holiday_days WHERE date = ?",
  ).get(date) as { day_type: HolidayDayType; name: string } | undefined;
  if (row?.day_type === "holiday") {
    return {
      date,
      isWorkday: false,
      isHoliday: true,
      dayType: "holiday",
      name: row.name,
      note: "法定节假日",
    };
  }
  if (row?.day_type === "workday") {
    return {
      date,
      isWorkday: true,
      isHoliday: false,
      dayType: "workday",
      name: row.name,
      note: `调休上班日（${row.name}补班）`,
    };
  }
  const weekend = parsed.weekday >= 6;
  return {
    date,
    isWorkday: !weekend,
    isHoliday: false,
    dayType: weekend ? "weekend" : "weekday",
  };
}

/** 整年原子替换入库：删除旧行 → 插入新行 → 标记 ready，失败整体回滚。 */
export function ingestHolidayYear(
  dataset: HolidayYearDataset,
  at = new Date(),
): { changed: boolean; days: number } {
  // H4：入口兜底校验，防止绕过 parseDataset/validateHolidayYear 写入非法日期。
  validateHolidayYear(dataset);
  const db = getDatabase();
  const existing = yearStatus(dataset.year);
  const samePayload = existing?.ready === true && existing.source === dataset.source;
  // payload_hash 通过表列比较，避免 readHolidayYear 不携带 hash 的问题。
  const existingMeta = metaRow(dataset.year);
  const unchanged = samePayload && existingMeta?.payload_hash === dataset.payloadHash;
  if (unchanged) return { changed: false, days: dataset.days.length };

  const timestamp = at.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    // 跨年行按日期自然年入库（如 2019 文件写入 2018-12-29/30/31）。
    // 若按 dataset.year 整年删除，后抓相邻上一年文件会清掉这些跨年行；
    // 改为按本数据集实际覆盖的日期范围删除：相邻标题年的覆盖范围互不重叠，
    // 天然保留另一个标题年写入的 12 月下旬行。
    const dates = dataset.days.map((day) => day.date);
    if (dates.length === 0) throw new Error("holiday dataset is empty");
    const minDate = dates.reduce((min, date) => (date < min ? date : min));
    const maxDate = dates.reduce((max, date) => (date > max ? date : max));
    db.prepare("DELETE FROM cn_holiday_days WHERE date >= ? AND date <= ?").run(minDate, maxDate);
    const insert = db.prepare(`
      INSERT INTO cn_holiday_days(date, year, day_type, name, source, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    for (const day of dataset.days) {
      insert.run(day.date, day.year, day.dayType, day.name, dataset.source, timestamp, timestamp);
    }
    db.prepare(`
      INSERT INTO cn_holiday_year_meta(year, status, source, payload_hash, fetched_at, last_attempt_at, last_error)
      VALUES(?, 'ready', ?, ?, ?, ?, NULL)
      ON CONFLICT(year) DO UPDATE SET
        status = 'ready',
        source = excluded.source,
        payload_hash = excluded.payload_hash,
        fetched_at = excluded.fetched_at,
        last_attempt_at = excluded.last_attempt_at,
        last_error = NULL
    `).run(dataset.year, dataset.source, dataset.payloadHash, timestamp, timestamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { changed: true, days: dataset.days.length };
}

function recordFailedAttempt(year: number, error: unknown, at: Date): void {
  const db = getDatabase();
  const timestamp = at.toISOString();
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(`
    INSERT INTO cn_holiday_year_meta(year, status, source, payload_hash, fetched_at, last_attempt_at, last_error)
    VALUES(?, 'failed', 'none', '', ?, ?, ?)
    ON CONFLICT(year) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      last_error = excluded.last_error
  `).run(year, timestamp, timestamp, message);
}

export interface EnsureHolidayYearOptions {
  fetch?: (year: number, options?: FetchHolidayYearOptions) => Promise<HolidayYearDataset>;
  allowFallback?: boolean;
  requireOfficialPapers?: boolean;
  cooldownMs?: number;
  at?: Date;
  /**
   * force=true：即使该年已 ready 也重新抓取入库（用于上游数据更正后的主动重拉）；
   * payload_hash 未变化时入库层按哈希去重，不产生数据写放大；同时跳过失败冷却。
   * 缺省（自动刷新/查询补齐路径）保持「已 ready 即短路」语义。
   */
  force?: boolean;
}

/** 确保某年数据可用：已 ready 直接返回（force 除外）；未 ready 且超过冷却时间则抓取入库。 */
export async function ensureHolidayYear(
  year: number,
  options: EnsureHolidayYearOptions = {},
): Promise<HolidayYearRecord> {
  const ready = readHolidayYear(year);
  if (ready && !options.force) return ready;

  const at = options.at ?? new Date();
  const cooldownMs = options.cooldownMs ?? DEFAULT_ATTEMPT_COOLDOWN_MS;
  const status = yearStatus(year);
  if (!options.force && status?.lastAttemptAt) {
    const elapsed = at.getTime() - Date.parse(status.lastAttemptAt);
    if (Number.isFinite(elapsed) && elapsed < cooldownMs) {
      throw new Error(
        `${year} 年节假日数据暂不可用（上次获取失败，${Math.max(1, Math.ceil((cooldownMs - elapsed) / 60_000))} 分钟后自动重试）`,
      );
    }
  }

  const fetch = options.fetch ?? defaultFetchHolidayYear;
  try {
    const dataset = await fetch(year, {
      allowFallback: options.allowFallback ?? true,
      requireOfficialPapers: options.requireOfficialPapers ?? false,
    });
    ingestHolidayYear(dataset, at);
    return readHolidayYear(year) as HolidayYearRecord;
  } catch (error) {
    recordFailedAttempt(year, error, at);
    throw error;
  }
}

/**
 * scheduler 每日刷新入口：确保当年数据；每年 10 月起尝试抓取下一年安排。
 * 次年数据只走主源（holiday-cn）并要求官方通知链接，避免入库非官方预估数据。
 */
export async function refreshHolidayCalendar(
  options: RefreshHolidayCalendarOptions = {},
): Promise<RefreshHolidayCalendarResult> {
  const at = options.at ?? new Date();
  const local = DateTime.fromJSDate(at, { zone: CHINA_ZONE });
  const years = [local.year];
  if (local.month >= 10) years.push(local.year + 1);

  const fetched: HolidayYearRecord[] = [];
  const skipped: Array<{ year: number; error: string }> = [];
  for (const year of years) {
    try {
      fetched.push(await ensureHolidayYear(year, {
        fetch: options.fetch,
        cooldownMs: options.cooldownMs,
        at,
        allowFallback: year === local.year,
        requireOfficialPapers: year !== local.year,
      }));
    } catch (error) {
      skipped.push({ year, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { at: at.toISOString(), years, fetched, skipped };
}

export function holidayYearView(year: number): HolidayYearView | undefined {
  const status = yearStatus(year);
  if (status?.ready !== true) return undefined;
  // chinese-days 是单自然年数据：year 文件不含上一年 12 月下旬的跨年行。
  // 只有 year-1 也是 chinese-days（其自然年文件才含 12 月行）时视图才完整；
  // year-1 未 ready、或 ready 但 source 为 holiday-cn（标题年文件不含 12 月行），
  // 都返回 undefined（unknown），不静默展示被截断的元旦假期（N3/N4）。
  // 支持范围起始年（2004）之前无上一自然年数据，按无跨年行处理。
  const prevStatus = year - 1 >= 2004 ? yearStatus(year - 1) : undefined;
  const prevProvidesCrossRows = year - 1 < 2004 || prevStatus?.source === "chinese-days";
  if (status.source === "chinese-days" && !prevProvidesCrossRows) {
    return undefined;
  }
  // 视图的年份语义 = 标题年假期安排：标题年全年 + 上一年 12/20 之后的跨年窗口
  // （与 HOLIDAY_WINDOWS 的元旦窗口 from=[12,20] 对齐）。maxDate 收窄到 12/19：
  // 自然年 year 的 12/20-12/31 行属于 year+1 标题年的元旦跨年段，不得外泄进本视图；
  // 中国法定假期没有落在 12/20-12/31 且属于本标题年的安排。
  const minDate = `${year - 1}-${YEAR_VIEW_COVERAGE_START}`;
  const maxDate = `${year}-${YEAR_VIEW_COVERAGE_END}`;
  const holidayRows = getDatabase().prepare(
    "SELECT date, name FROM cn_holiday_days WHERE date >= ? AND date <= ? AND day_type = 'holiday' ORDER BY date",
  ).all(minDate, maxDate) as Array<{ date: string; name: string }>;
  const workdayRows = getDatabase().prepare(
    "SELECT date, name FROM cn_holiday_days WHERE date >= ? AND date <= ? AND day_type = 'workday' ORDER BY date",
  ).all(minDate, maxDate) as Array<{ date: string; name: string }>;

  const periods: HolidayPeriod[] = [];
  let current: { names: string[]; start: string; end: string } | undefined;
  for (const row of holidayRows) {
    const previous = current?.end ? DateTime.fromISO(current.end, { zone: CHINA_ZONE }) : undefined;
    const day = DateTime.fromISO(row.date, { zone: CHINA_ZONE });
    if (previous && day.diff(previous, "days").days === 1) {
      current!.end = row.date;
      if (!current!.names.includes(row.name)) current!.names.push(row.name);
    } else {
      if (current) periods.push({ name: current.names.join("、"), startDate: current.start, endDate: current.end, days: 0, makeUpWorkdays: [] });
      current = { names: [row.name], start: row.date, end: row.date };
    }
  }
  if (current) periods.push({ name: current.names.join("、"), startDate: current.start, endDate: current.end, days: 0, makeUpWorkdays: [] });

  for (const period of periods) {
    const start = DateTime.fromISO(period.startDate, { zone: CHINA_ZONE });
    const end = DateTime.fromISO(period.endDate, { zone: CHINA_ZONE });
    period.days = Math.round(end.diff(start, "days").days) + 1;
  }
  // 补班日按「最近的同名连休段 + 10 天窗口」关联：补班日本质上紧邻休假期
  // 前后（如 12/29 之于 12/30-1/1），但不应按名称无界匹配而串染到
  // 其他标题年的同名段。每个补班日只归属距离最近的一段。
  for (const row of workdayRows) {
    const rowDay = DateTime.fromISO(row.date, { zone: CHINA_ZONE });
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    periods.forEach((period, index) => {
      if (!holidayNameHits(row.name).some((name) => period.name.includes(name))) return;
      const toStart = Math.abs(rowDay.diff(DateTime.fromISO(period.startDate, { zone: CHINA_ZONE }), "days").days);
      const toEnd = Math.abs(rowDay.diff(DateTime.fromISO(period.endDate, { zone: CHINA_ZONE }), "days").days);
      const distance = Math.min(toStart, toEnd);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestDistance <= 10) {
      periods[bestIndex].makeUpWorkdays.push({ date: row.date, name: row.name });
    }
  }
  return {
    year,
    periods,
    workdays: workdayRows.map((row) => ({ date: row.date, name: row.name })),
  };
}

export function nextHoliday(from = new Date()): NextHolidayResult {
  const local = DateTime.fromJSDate(from, { zone: CHINA_ZONE });
  const today = local.toISODate() as string;
  const todayDay = local.startOf("day");
  let coveredUntil: string | undefined;
  for (let year = local.year; year <= local.year + 2; year += 1) {
    const view = holidayYearView(year);
    if (!view) {
      // 非对称 ready：today 处于 year 的跨年窗口（year-12-20 起）时，
      // year+1 标题年数据已覆盖该区间；year+1 确实 ready 才继续，否则维持 unknown，
      // 保持「缺数据不猜测」。
      const nextViewReady = year + 1 <= local.year + 2
        && holidayYearView(year + 1) !== undefined;
      if (today >= `${year}-${YEAR_VIEW_COVERAGE_START}` && nextViewReady) continue;
      return {
        status: "unknown",
        today,
        coveredUntil,
        message: `${year} 年节假日安排尚未获取，scheduler 会在发布窗口自动更新，请稍后重试。`,
      };
    }
    coveredUntil = `${year}-${YEAR_VIEW_COVERAGE_END}`;
    for (const period of view.periods) {
      if (period.endDate < today) continue;
      if (period.startDate <= today) {
        const end = DateTime.fromISO(period.endDate, { zone: CHINA_ZONE }).startOf("day");
        return {
          status: "ongoing",
          today,
          holidayName: period.name,
          startDate: period.startDate,
          endDate: period.endDate,
          days: period.days,
          countdownDays: 0,
          remainingDays: Math.max(0, Math.round(end.diff(todayDay, "days").days)),
          makeUpWorkdays: period.makeUpWorkdays,
        };
      }
      const start = DateTime.fromISO(period.startDate, { zone: CHINA_ZONE }).startOf("day");
      return {
        status: "upcoming",
        today,
        holidayName: period.name,
        startDate: period.startDate,
        endDate: period.endDate,
        days: period.days,
        countdownDays: Math.max(0, Math.round(start.diff(todayDay, "days").days)),
        makeUpWorkdays: period.makeUpWorkdays,
      };
    }
  }
  return {
    status: "unknown",
    today,
    coveredUntil,
    message: "已覆盖年份内没有更多法定节假日安排。",
  };
}
