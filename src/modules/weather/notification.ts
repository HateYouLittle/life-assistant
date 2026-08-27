import { DateTime } from "luxon";
import {
  registerNotificationBlocks,
  type EnvelopeFor,
  type NotificationEnvelope,
  type RenderBlock,
} from "../../core/notification.js";
import type { InferredWeatherRisk, OfficialWeatherAlert, WeatherAlert } from "./provider.js";

// ---------------------------------------------------------------------------
// 载荷与渲染归本模块所有；core 只保留信封骨架与投影管道。
// ---------------------------------------------------------------------------

export interface DailyWeatherPayload {
  city: string;
  current?: {
    weather: string;
    temperatureC: number;
    apparentTemperatureC?: number;
    humidityPercent?: number;
  };
  today?: {
    weather: string;
    minTemperatureC: number;
    maxTemperatureC: number;
  };
  precipitation?: {
    probabilityPercent?: number;
    amountMm?: number;
  };
  airQuality?: {
    scale: "CN" | "US";
    aqi: number;
    category: string;
  };
  advice?: string;
}

export interface OfficialWeatherAlertPayload {
  type: string;
  level?: string;
  issuedAt?: string;
  impactStartsAt?: string;
  impactEndsAt?: string;
  timezone: string;
  area?: string;
  risk?: string;
  advice?: string;
}

export interface WeatherInferredAlertPayload {
  title: string;
  description: string;
  timezone: string;
}

export type DailyBriefEnvelope = EnvelopeFor<"weather.daily_brief", DailyWeatherPayload>;
export type OfficialAlertEnvelope = EnvelopeFor<"weather.official_alert", OfficialWeatherAlertPayload>;
export type InferredAlertEnvelope = EnvelopeFor<"weather.inferred_alert", WeatherInferredAlertPayload>;

export interface OfficialAlertNotificationOptions {
  generatedAt: string;
  timezone: string;
}

export interface InferredAlertNotificationOptions {
  generatedAt: string;
  timezone: string;
}

export function weatherAlertIdentity(alert: OfficialWeatherAlert): string {
  if (alert.id) return `alert:id:${encodeURIComponent(alert.id)}`;
  if (!alert.publisher || !alert.issuedAt || !alert.eventType || !alert.level) {
    throw new Error("official weather alert lacks provider ID and complete fallback identity fields");
  }
  return `alert:fallback:${[alert.publisher, alert.issuedAt, alert.eventType, alert.level]
    .map((value) => encodeURIComponent(value))
    .join(":")}`;
}

export function legacyWeatherAlertDedupeKeys(alert: WeatherAlert, at: Date): string[] {
  const label = alert.kind === "official" ? alert.headline : alert.title;
  const currentDate = at.toISOString().slice(0, 10);
  const previousDate = new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return [
    `weather:alert:${label}:${currentDate}`,
    `weather:alert:${label}:${previousDate}`,
  ];
}

export function officialAlertNotification(
  alert: OfficialWeatherAlert,
  options: OfficialAlertNotificationOptions,
): OfficialAlertEnvelope {
  const level = alert.level ?? "";
  const subject = `${alert.eventType}${level}预警`;
  return {
    kind: "weather.official_alert",
    identity: weatherAlertIdentity(alert),
    source: "weather",
    scope: { type: "global" },
    headline: alert.criteria
      ? `${subject}：${alert.criteria}`
      : alert.publisher
        ? `${subject}：${alert.publisher}已发布`
        : `${subject}已发布`,
    generatedAt: options.generatedAt,
    // 迁移兼容：旧版本键形如 weather:alert:{label}:{date}；构造时随信封携带，
    // 发布层命中旧行会改键复用，避免升级当天重复推送。
    legacyDedupeKeys: legacyWeatherAlertDedupeKeys(alert, new Date(options.generatedAt)),
    provenance: { provider: "和风天气", publisher: alert.publisher },
    payload: {
      type: alert.eventType,
      level: alert.level,
      issuedAt: alert.issuedAt,
      impactStartsAt: alert.onsetAt ?? alert.effectiveAt,
      impactEndsAt: alert.expiresAt,
      timezone: options.timezone,
      risk: alert.criteria,
      advice: alert.instruction,
    },
    details: alert.description,
  };
}

export function inferredAlertNotification(
  alert: InferredWeatherRisk,
  options: InferredAlertNotificationOptions,
): InferredAlertEnvelope {
  const localDate = DateTime.fromISO(options.generatedAt, { setZone: true })
    .setZone(options.timezone)
    .toISODate();
  if (!localDate) throw new Error(`invalid inferred alert timezone: ${options.timezone}`);
  return {
    kind: "weather.inferred_alert",
    identity: `inferred:${encodeURIComponent(alert.title)}:${localDate}`,
    source: "weather",
    scope: { type: "global" },
    headline: `系统推断风险：${alert.title}`,
    generatedAt: options.generatedAt,
    legacyDedupeKeys: legacyWeatherAlertDedupeKeys(alert, new Date(options.generatedAt)),
    payload: {
      title: alert.title,
      description: alert.description,
      timezone: options.timezone,
    },
  };
}

// ---------------------------------------------------------------------------
// RenderBlock[] 构造器（自 core/notification.ts 下放，逻辑逐行保留）
// ---------------------------------------------------------------------------

function dailyWeatherBlocks(payload: DailyWeatherPayload): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  if (payload.current) {
    const current = payload.current;
    const facts = [`${current.weather}，${current.temperatureC}℃`];
    if (current.apparentTemperatureC !== undefined) facts.push(`体感${current.apparentTemperatureC}℃`);
    if (current.humidityPercent !== undefined) facts.push(`湿度${current.humidityPercent}%`);
    blocks.push({ type: "label", label: "当前", value: facts.join("，") });
  }
  if (payload.today) {
    const today = payload.today;
    blocks.push({
      type: "label",
      label: "今日",
      value: `${today.minTemperatureC}～${today.maxTemperatureC}℃，${today.weather}`,
    });
  }
  if (payload.precipitation?.probabilityPercent !== undefined) {
    blocks.push({ type: "label", label: "降水", value: `最高概率${payload.precipitation.probabilityPercent}%` });
  } else if (payload.precipitation?.amountMm !== undefined) {
    blocks.push({ type: "label", label: "降水", value: `预计${payload.precipitation.amountMm}mm` });
  }
  if (payload.airQuality) {
    const scale = payload.airQuality.scale === "CN" ? "国标" : "美标";
    blocks.push({
      type: "label",
      label: "空气",
      value: `AQI ${payload.airQuality.aqi}，${payload.airQuality.category}（${scale}）`,
    });
  }
  if (payload.advice) blocks.push({ type: "label", label: "建议", value: payload.advice });
  return blocks;
}

function formatDateTime(value: string, timezone: string): string {
  return DateTime.fromISO(value, { setZone: true }).setZone(timezone).toFormat("yyyy年M月d日 HH:mm");
}

function officialAlertBlocks(notification: NotificationEnvelope): RenderBlock[] {
  const payload = notification.payload as OfficialWeatherAlertPayload;
  const { provenance } = notification;
  const blocks: RenderBlock[] = [];
  const timeParts: string[] = [];
  if (payload.issuedAt) {
    const issuedAt = formatDateTime(payload.issuedAt, payload.timezone);
    timeParts.push(provenance?.publisher ? `${provenance.publisher}于 ${issuedAt} 发布` : `${issuedAt} 发布`);
  }
  if (payload.impactStartsAt && payload.impactEndsAt) {
    timeParts.push(`影响时段：${formatDateTime(payload.impactStartsAt, payload.timezone)} 至 ${formatDateTime(payload.impactEndsAt, payload.timezone)}`);
  } else if (payload.impactStartsAt) {
    timeParts.push(`影响开始：${formatDateTime(payload.impactStartsAt, payload.timezone)}`);
  } else if (payload.impactEndsAt) {
    timeParts.push(`影响至：${formatDateTime(payload.impactEndsAt, payload.timezone)}`);
  }
  if (timeParts.length > 0) blocks.push({ type: "label", label: "时间", value: timeParts.join("；") });
  if (payload.area) blocks.push({ type: "label", label: "区域", value: payload.area });
  if (payload.risk) blocks.push({ type: "label", label: "风险", value: payload.risk });
  if (payload.advice) blocks.push({ type: "label", label: "建议", value: payload.advice });
  const publisher = provenance?.publisher;
  const provider = provenance?.provider;
  if (publisher && provider) {
    blocks.push({ type: "label", label: "来源", value: `${publisher}（${provider}）` });
  } else if (publisher) {
    blocks.push({ type: "label", label: "来源", value: publisher });
  } else if (provider) {
    blocks.push({ type: "label", label: "来源", value: provider });
  }
  if (notification.details) {
    blocks.push({ type: "section" });
    blocks.push({ type: "line", text: "官方原文：" });
    blocks.push({ type: "raw", text: notification.details });
  }
  return blocks;
}

function inferredAlertBlocks(payload: WeatherInferredAlertPayload): RenderBlock[] {
  return [{ type: "label", label: "风险", value: payload.description, plainNoPrefix: true }];
}

registerNotificationBlocks("weather.daily_brief", (n) => dailyWeatherBlocks(n.payload as DailyWeatherPayload));
registerNotificationBlocks("weather.official_alert", officialAlertBlocks);
registerNotificationBlocks("weather.inferred_alert", (n) => inferredAlertBlocks(n.payload as WeatherInferredAlertPayload));
