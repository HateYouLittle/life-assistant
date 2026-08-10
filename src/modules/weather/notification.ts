import { DateTime } from "luxon";
import type { NotificationEnvelope } from "../../core/notification.js";
import type { InferredWeatherRisk, OfficialWeatherAlert, WeatherAlert } from "./provider.js";

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
): Extract<NotificationEnvelope, { kind: "weather.official_alert" }> {
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
): Extract<NotificationEnvelope, { kind: "weather.inferred_alert" }> {
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
    payload: {
      title: alert.title,
      description: alert.description,
      timezone: options.timezone,
    },
  };
}
