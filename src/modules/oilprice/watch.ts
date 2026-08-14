import { DateTime } from "luxon";
import { currentLocation } from "../../core/location.js";
import { publishNotification } from "../../core/notification-publisher.js";
import { publishGlobal } from "../../core/notifier.js";
import { store } from "../../core/store.js";
import { advanceNoticeNotification, officialResultNotification } from "./notification.js";
import {
  fetchOilPrice,
  type FetchOilPriceOptions,
  type FuelKey,
  type OilPriceObservation,
} from "./provider.js";
import { nearestWindowDeviationDays, nextWindow } from "./schedule.js";

const BUSINESS_TIMEZONE = "Asia/Shanghai";
const FUEL_KEYS: FuelKey[] = ["p92", "p95", "p0"];

type GlobalPublisher = (
  source: string,
  title: string,
  body: string,
  dedupeKey: string,
  legacyDedupeKeys?: readonly string[],
) => Promise<void>;

export interface OilPriceState {
  schemaVersion: 1;
  initialized: true;
  province: string;
  unit: "元/升";
  provider: string;
  fuels: Record<FuelKey, string>;
  providerEffectiveDate?: string;
  windowDate?: string;
  observedAt: string;
  lastProcessedWindow?: string;
}

export interface OilPriceStateRepository {
  get(province: string): OilPriceState | undefined;
  set(state: OilPriceState): void;
}

function stateKey(province: string): string {
  return `oilprice:state:${encodeURIComponent(province)}`;
}

export const oilPriceStateRepository: OilPriceStateRepository = {
  get(province) {
    return store.get<OilPriceState>(stateKey(province));
  },
  set(state) {
    store.set(stateKey(state.province), state);
  },
};

function observedAt(value: Date): string {
  const result = DateTime.fromJSDate(value).setZone(BUSINESS_TIMEZONE).toISO({ suppressMilliseconds: true });
  if (!result) throw new Error("invalid oil-price observation time");
  return result;
}

function currentFuels(observation: OilPriceObservation): Record<FuelKey, string> | undefined {
  const result = {} as Record<FuelKey, string>;
  for (const key of FUEL_KEYS) {
    const current = observation.fuels?.[key]?.current;
    if (typeof current !== "string" || !/^\d+\.\d{2}$/.test(current)) return undefined;
    result[key] = current;
  }
  return result;
}

/**
 * 校验持久化 state 的形状：必填字符串字段、油价为两位小数正价格、可选字段为 string 或缺失。
 * schemaVersion 允许缺失（升级前的完整旧 state 视为合法，避免吞掉在途窗口的正式结果）；
 * 用于识别损坏/旧格式的持久化数据，避免每日 TypeError 死循环。
 */
export function isValidOilPriceState(state: unknown): state is OilPriceState {
  if (!state || typeof state !== "object") return false;
  const candidate = state as Record<string, unknown>;
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== 1) return false;
  if (candidate.initialized !== true) return false;
  if (typeof candidate.province !== "string") return false;
  if (candidate.unit !== "元/升") return false;
  if (typeof candidate.provider !== "string") return false;
  if (typeof candidate.observedAt !== "string") return false;
  const fuels = candidate.fuels;
  if (!fuels || typeof fuels !== "object") return false;
  for (const key of FUEL_KEYS) {
    const price = (fuels as Record<string, unknown>)[key];
    if (typeof price !== "string" || !/^\d+\.\d{2}$/.test(price)) return false;
  }
  for (const field of ["providerEffectiveDate", "windowDate", "lastProcessedWindow"] as const) {
    const value = candidate[field];
    if (value !== undefined && typeof value !== "string") return false;
  }
  return true;
}

function cents(value: string): bigint | undefined {
  if (!/^-?\d+\.\d{2}$/.test(value)) return undefined;
  const negative = value.startsWith("-");
  const [whole, fraction] = (negative ? value.slice(1) : value).split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -amount : amount;
}

function completeAdjustmentEvidence(observation: OilPriceObservation, state: OilPriceState): boolean {
  if (!observation.adjustmentEvidence) return false;
  if (observation.province !== state.province || observation.unit !== state.unit) return false;
  for (const key of FUEL_KEYS) {
    const fuel = observation.fuels?.[key];
    if (!fuel) return false;
    const current = cents(fuel.current);
    const previous = cents(fuel.previous);
    const change = cents(fuel.change);
    if (current === undefined || previous === undefined || change === undefined) return false;
    // 与 provider.ts 的 ±1 分容差保持同一口径：数据源四舍五入口径不同时仍视为证据完整，
    // 否则该窗口的正式结果会被静默丢弃（二次审查 P1）。
    const delta = (current - previous) - change;
    if (delta > 1n || delta < -1n) return false;
  }
  return true;
}

function completeAndConsistent(observation: OilPriceObservation, state: OilPriceState): boolean {
  if (!completeAdjustmentEvidence(observation, state) || !observation.adjustmentEvidence) return false;
  let hasAdjustment = false;
  for (const key of FUEL_KEYS) {
    const fuel = observation.fuels[key];
    if (fuel.previous !== state.fuels[key]) return false;
    if (cents(fuel.change) !== 0n) hasAdjustment = true;
  }
  return hasAdjustment;
}

function baseline(observation: OilPriceObservation, at: Date, lastProcessedWindow?: string): OilPriceState | undefined {
  const fuels = currentFuels(observation);
  if (!fuels) return undefined;
  const state: OilPriceState = {
    schemaVersion: 1,
    initialized: true,
    province: observation.province,
    unit: observation.unit,
    provider: observation.provider,
    fuels,
    observedAt: observedAt(at),
  };
  if (observation.adjustmentEvidence) {
    state.providerEffectiveDate = observation.providerEffectiveDate;
    state.windowDate = observation.windowDate;
  }
  if (lastProcessedWindow) state.lastProcessedWindow = lastProcessedWindow;
  return state;
}

export type OilPriceObservationOutcome = "baseline" | "published" | "ignored" | "retry";

export async function observeOilPrice(
  observation: OilPriceObservation,
  options: {
    observedAt: Date;
    repository?: OilPriceStateRepository;
    publish?: GlobalPublisher;
  },
): Promise<OilPriceObservationOutcome> {
  // 与静态窗口表交叉校验：Provider 的 windowDate 应贴近表中最近窗口（±1 天容差），
  // 偏差过大只告警不失败（覆盖 last_adjusted 语义歧义与表漂移两类风险）。
  if (observation.adjustmentEvidence && observation.windowDate) {
    const deviation = nearestWindowDeviationDays(observation.windowDate);
    if (deviation !== null && deviation > 1) {
      console.error(
        `[oilprice] provider window date deviates from static table by ${Math.round(deviation)}d: observed ${observation.windowDate}`,
      );
    }
  }

  const repository = options.repository ?? oilPriceStateRepository;
  let state = repository.get(observation.province);
  if (state && !isValidOilPriceState(state)) {
    // 损坏或旧格式的持久化 state：记录错误后按不存在处理，重建 baseline，避免每日 TypeError 死循环
    console.error("[oilprice] invalid persisted state; rebuilding baseline");
    state = undefined;
  }
  if (!state) {
    const initial = baseline(observation, options.observedAt);
    if (!initial) return "retry";
    repository.set(initial);
    return "baseline";
  }

  if (!observation.adjustmentEvidence) return "ignored";
  if (!state.windowDate) {
    const initialTian = baseline(observation, options.observedAt, state.lastProcessedWindow);
    if (!initialTian) return "retry";
    repository.set(initialTian);
    return "baseline";
  }
  if (observation.windowDate < state.windowDate) return "ignored";
  if (observation.windowDate === state.windowDate) {
    if (completeAdjustmentEvidence(observation, state)) {
      const revised = baseline(observation, options.observedAt, state.lastProcessedWindow);
      if (!revised) return "retry";
      repository.set(revised);
    }
    return "ignored";
  }

  const effective = DateTime.fromISO(observation.providerEffectiveDate, { zone: BUSINESS_TIMEZONE }).startOf("day");
  if (!effective.isValid) return "retry";
  const timestamp = options.observedAt.getTime();
  if (timestamp > effective.plus({ hours: 48 }).toMillis()) {
    const nextState = baseline(observation, options.observedAt, state.lastProcessedWindow);
    if (!nextState) return "retry";
    repository.set(nextState);
    return "baseline";
  }
  if (timestamp < effective.toMillis() || !completeAndConsistent(observation, state)) return "retry";

  const effectiveAt = effective.toISO({ suppressMilliseconds: true });
  if (!effectiveAt) return "retry";
  const notification = officialResultNotification({
    province: observation.province,
    windowDate: observation.windowDate,
    effectiveAt,
    generatedAt: observedAt(options.observedAt),
    provider: observation.provider,
    source: observation.source,
    unit: observation.unit,
    fuels: observation.fuels,
  });
  await publishNotification(notification, { publishGlobal: options.publish ?? publishGlobal });
  const nextState = baseline(observation, options.observedAt, observation.windowDate);
  if (!nextState) return "retry";
  repository.set(nextState);
  return "published";
}

export interface OilPriceWatchOptions {
  at?: Date;
  getLocation?: () => { city: string; province?: string } | null;
  fetchPrice?: (city: string, options?: FetchOilPriceOptions) => Promise<OilPriceObservation>;
  repository?: OilPriceStateRepository;
  publish?: GlobalPublisher;
}

export async function runOilPriceWatch(options: OilPriceWatchOptions = {}): Promise<void> {
  const at = options.at ?? new Date();
  const publish = options.publish ?? publishGlobal;
  const errors: unknown[] = [];
  const window = nextWindow(at);
  if (!window) {
    // 窗口表已用尽：仅关闭 advance 通知，油价观测与正式结果链路继续正常跑
    console.error(
      "[oilprice] adjustment window table exhausted; advance notices disabled — update ADJUSTMENT_WINDOWS in src/modules/oilprice/schedule.ts",
    );
  } else if (window.hoursUntil < 40) {
    try {
      await publishNotification(advanceNoticeNotification({
        windowDate: window.date,
        effectiveAt: window.effectiveAt,
        generatedAt: observedAt(at),
      }), { publishGlobal: publish });
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    const location = (options.getLocation ?? currentLocation)();
    if (location) {
      const observation = await (options.fetchPrice ?? fetchOilPrice)(location.city, { province: location.province });
      await observeOilPrice(observation, {
        observedAt: at,
        repository: options.repository,
        publish,
      });
    }
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "oil-price watch failed");
}
