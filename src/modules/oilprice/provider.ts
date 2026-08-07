import { DateTime } from "luxon";
import { config } from "../../config.js";
import { httpJson as defaultHttpJson } from "../../core/http.js";

const BUSINESS_TIMEZONE = "Asia/Shanghai";
const UNIT = "元/升" as const;
const FUEL_KEYS = ["p92", "p95", "p0"] as const;

export type FuelKey = typeof FUEL_KEYS[number];
export interface CurrentFuelPrice {
  current: string;
}
export interface AdjustmentFuelPrice extends CurrentFuelPrice {
  previous: string;
  change: string;
}

interface OilPriceBase {
  province: string;
  unit: typeof UNIT;
  provider: string;
  source: string;
}

export interface TianApiOilPrice extends OilPriceBase {
  adjustmentEvidence: true;
  provider: "TianAPI";
  fuels: Record<FuelKey, AdjustmentFuelPrice>;
  providerEffectiveDate: string;
  windowDate: string;
  nextWindowDate: string;
}

export interface JuheOilPrice extends OilPriceBase {
  adjustmentEvidence: false;
  provider: "JUHE";
  fuels: Record<FuelKey, CurrentFuelPrice>;
}

export type OilPriceObservation = TianApiOilPrice | JuheOilPrice;

const CITY_TO_PROVINCE: Record<string, string> = {
  南昌: "江西", 九江: "江西", 上饶: "江西", 抚州: "江西", 宜春: "江西",
  吉安: "江西", 赣州: "江西", 景德镇: "江西", 萍乡: "江西", 新余: "江西",
  鹰潭: "江西",
  北京: "北京", 上海: "上海", 天津: "天津", 重庆: "重庆",
  广州: "广东", 深圳: "广东", 东莞: "广东", 佛山: "广东", 珠海: "广东",
  杭州: "浙江", 宁波: "浙江", 温州: "浙江", 南京: "江苏", 苏州: "江苏",
  无锡: "江苏", 武汉: "湖北", 长沙: "湖南", 成都: "四川", 郑州: "河南",
  济南: "山东", 青岛: "山东", 福州: "福建", 厦门: "福建", 西安: "陕西",
  昆明: "云南", 贵阳: "贵州", 合肥: "安徽", 石家庄: "河北", 太原: "山西",
  沈阳: "辽宁", 大连: "辽宁", 长春: "吉林", 哈尔滨: "黑龙江", 兰州: "甘肃",
  银川: "宁夏", 西宁: "青海", 拉萨: "西藏", 乌鲁木齐: "新疆",
  呼和浩特: "内蒙古", 南宁: "广西", 海口: "海南",
};

/** Normalize a saved city/district name to the province names used by both providers. */
export function provinceOf(city: string): string | undefined {
  const trimmed = city.trim();
  const provinces = new Set(Object.values(CITY_TO_PROVINCE));
  if (provinces.has(trimmed)) return trimmed;
  if (CITY_TO_PROVINCE[trimmed]) return CITY_TO_PROVINCE[trimmed];
  for (const suffix of ["特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区", "自治区", "省", "市"]) {
    if (!trimmed.endsWith(suffix)) continue;
    const withoutSuffix = trimmed.slice(0, -suffix.length);
    if (provinces.has(withoutSuffix)) return withoutSuffix;
    if (CITY_TO_PROVINCE[withoutSuffix]) return CITY_TO_PROVINCE[withoutSuffix];
  }
  let probe = trimmed;
  while (probe.length >= 2) {
    const hit = CITY_TO_PROVINCE[probe];
    if (hit) return hit;
    probe = probe.slice(0, -1);
  }
  for (const [cityName, province] of Object.entries(CITY_TO_PROVINCE)) {
    if (trimmed.includes(cityName)) return province;
  }
  return undefined;
}

function decimalCents(value: unknown, field: string, positive: boolean): { cents: bigint; text: string } {
  const raw = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error(`${field} must be a finite decimal with at most 2 decimal places`);
  }
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const signedCents = negative ? -cents : cents;
  if (positive && signedCents <= 0n) throw new Error(`${field} must be positive`);
  const magnitude = signedCents < 0n ? -signedCents : signedCents;
  const text = `${signedCents < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
  return { cents: signedCents, text };
}

function providerDate(value: unknown, field: string): DateTime<true> {
  const raw = String(value ?? "");
  if (!/^\d{8}$/.test(raw)) throw new Error(`${field} must use yyyyMMdd`);
  const date = DateTime.fromFormat(raw, "yyyyMMdd", { zone: BUSINESS_TIMEZONE });
  if (!date.isValid || date.toFormat("yyyyMMdd") !== raw) throw new Error(`${field} is not a valid date`);
  return date as DateTime<true>;
}

function adjustmentFuel(value: unknown, key: FuelKey): AdjustmentFuelPrice {
  if (!value || typeof value !== "object") throw new Error(`${key} adjustment evidence is missing`);
  const raw = value as Record<string, unknown>;
  const current = decimalCents(raw.price, `${key}.price`, true);
  const previous = decimalCents(raw.previous_price, `${key}.previous_price`, true);
  const change = decimalCents(raw.price_change, `${key}.price_change`, false);
  if (current.cents - previous.cents !== change.cents) {
    throw new Error(`${key} exact cents difference does not match price_change`);
  }
  return { current: current.text, previous: previous.text, change: change.text };
}

function currentFuel(value: unknown, field: string): CurrentFuelPrice {
  return { current: decimalCents(value, field, true).text };
}

type HttpJson = (url: string) => Promise<unknown>;

export interface FetchOilPriceOptions {
  province?: string;
  tianapiKey?: string;
  juheKey?: string;
  httpJson?: HttpJson;
}

export async function fetchOilPrice(city: string, options: FetchOilPriceOptions = {}): Promise<OilPriceObservation> {
  const tianapiKey = options.tianapiKey ?? config.tianapiKey;
  const juheKey = options.juheKey ?? config.juheKey;
  const httpJson = options.httpJson ?? defaultHttpJson as HttpJson;
  const province = options.province === undefined ? provinceOf(city) : provinceOf(options.province);

  if (tianapiKey && province) {
    try {
      let response: Record<string, unknown>;
      try {
        response = await httpJson(
          `https://apis.tianapi.com/oilprice/market?key=${encodeURIComponent(tianapiKey)}&prov=${encodeURIComponent(province)}`,
        ) as Record<string, unknown>;
      } catch {
        throw new Error("TianAPI oil-price request failed");
      }
      if (response.code !== 200) throw new Error(String(response.msg ?? `TianAPI returned code=${response.code}`));
      if (!response.result || typeof response.result !== "object") throw new Error("TianAPI market result is missing");
      const result = response.result as Record<string, unknown>;
      const providerEffective = providerDate(result.last_adjusted, "last_adjusted");
      const nextEffective = providerDate(result.next_adjustment, "next_adjustment");
      const providerProvince = typeof result.prov === "string" ? provinceOf(result.prov) : undefined;
      if (providerProvince !== province) {
        throw new Error(`TianAPI province mismatch: requested ${province}, received ${String(result.prov ?? "missing")}`);
      }
      return {
        adjustmentEvidence: true,
        province: providerProvince,
        unit: UNIT,
        provider: "TianAPI",
        source: "TianAPI 成品油市场数据",
        providerEffectiveDate: providerEffective.toISODate(),
        windowDate: providerEffective.minus({ days: 1 }).toISODate(),
        nextWindowDate: nextEffective.minus({ days: 1 }).toISODate(),
        fuels: {
          p92: adjustmentFuel(result.p92, "p92"),
          p95: adjustmentFuel(result.p95, "p95"),
          p0: adjustmentFuel(result.p0, "p0"),
        },
      };
    } catch (error) {
      if (!juheKey) throw error;
    }
  }

  if (juheKey) {
    let response: Record<string, unknown>;
    try {
      response = await httpJson(
        `https://apis.juhe.cn/gnyj/query?key=${encodeURIComponent(juheKey)}`,
      ) as Record<string, unknown>;
    } catch {
      throw new Error("JUHE oil-price request failed");
    }
    const succeeded = response.error_code === 0;
    if (!succeeded || !Array.isArray(response.result)) {
      const code = response.error_code ?? response.resultcode ?? "missing result";
      throw new Error(`JUHE oil-price query failed: ${String(code)} ${String(response.reason ?? "")}`.trim());
    }
    const hit = response.result.find((item) => {
      if (!item || typeof item !== "object") return false;
      const candidate = (item as Record<string, unknown>).city;
      return typeof candidate === "string" && (candidate === province || candidate === city.trim());
    }) as Record<string, unknown> | undefined;
    if (!hit || typeof hit.city !== "string") throw new Error(`oil-price provider does not cover ${province ?? city}`);
    return {
      adjustmentEvidence: false,
      province: hit.city,
      unit: UNIT,
      provider: "JUHE",
      source: "聚合数据当前油价",
      fuels: {
        p92: currentFuel(hit["92h"], "JUHE 92h"),
        p95: currentFuel(hit["95h"], "JUHE 95h"),
        p0: currentFuel(hit["0h"], "JUHE 0h"),
      },
    };
  }

  throw new Error("oil-price provider is not configured; set TIANAPI_KEY or JUHE_KEY");
}
