import { DateTime } from "luxon";

export type NotificationScope =
  | { type: "global" }
  | { type: "profile"; profileId: string };

export interface NotificationProvenance {
  provider?: string;
  publisher?: string;
}

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

interface NotificationCore {
  identity: string;
  source: string;
  scope: NotificationScope;
  headline: string;
  generatedAt: string;
  provenance?: NotificationProvenance;
  details?: string;
}

export type NotificationEnvelope = NotificationCore & (
  | { kind: "weather.daily_brief"; payload: DailyWeatherPayload }
  | { kind: "weather.official_alert"; payload: OfficialWeatherAlertPayload }
);

export interface RenderedNotification {
  title: string;
  body: string;
}

function renderDailyWeather(payload: DailyWeatherPayload): string {
  const lines: string[] = [];
  if (payload.current) {
    const current = payload.current;
    const facts = [`${current.weather}，${current.temperatureC}℃`];
    if (current.apparentTemperatureC !== undefined) facts.push(`体感${current.apparentTemperatureC}℃`);
    if (current.humidityPercent !== undefined) facts.push(`湿度${current.humidityPercent}%`);
    lines.push(`当前：${facts.join("，")}`);
  }
  if (payload.today) {
    const today = payload.today;
    lines.push(`今日：${today.minTemperatureC}～${today.maxTemperatureC}℃，${today.weather}`);
  }
  if (payload.precipitation?.probabilityPercent !== undefined) {
    lines.push(`降水：最高概率${payload.precipitation.probabilityPercent}%`);
  } else if (payload.precipitation?.amountMm !== undefined) {
    lines.push(`降水：预计${payload.precipitation.amountMm}mm`);
  }
  if (payload.advice) lines.push(`建议：${payload.advice}`);
  return lines.join("\n");
}

function formatDateTime(value: string, timezone: string): string {
  return DateTime.fromISO(value, { setZone: true }).setZone(timezone).toFormat("yyyy年M月d日 HH:mm");
}

function renderOfficialAlert(notification: Extract<NotificationEnvelope, { kind: "weather.official_alert" }>): string {
  const { payload, provenance } = notification;
  const lines: string[] = [];
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
  if (timeParts.length > 0) lines.push(`时间：${timeParts.join("；")}`);
  if (payload.area) lines.push(`区域：${payload.area}`);
  if (payload.risk) lines.push(`风险：${payload.risk}`);
  if (payload.advice) lines.push(`建议：${payload.advice}`);
  if (provenance?.publisher && provenance.provider) {
    lines.push(`来源：${provenance.publisher}（${provenance.provider}）`);
  } else if (provenance?.publisher || provenance?.provider) {
    lines.push(`来源：${provenance.publisher ?? provenance.provider}`);
  }
  if (notification.details) lines.push("", "官方原文：", notification.details);
  return lines.join("\n");
}

export function renderNotification(notification: NotificationEnvelope): RenderedNotification {
  return {
    title: notification.headline,
    body: notification.kind === "weather.daily_brief"
      ? renderDailyWeather(notification.payload)
      : renderOfficialAlert(notification),
  };
}
