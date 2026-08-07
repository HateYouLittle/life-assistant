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

export interface OilPriceAdvanceNoticePayload {
  windowDate: string;
  effectiveAt: string;
  timezone: string;
  tip: string;
}

export interface OilPriceOfficialResultPayload {
  province: string;
  windowDate: string;
  effectiveAt: string;
  timezone: string;
  unit: "元/升";
  fuels: Record<"p92" | "p95" | "p0", { current: string; change: string }>;
  source: string;
}

export interface ScheduleReminderPayload {
  title: string;
  eventAt: string;
  occurrenceAt?: string;
  deadlineAt?: string;
  targetAt?: string;
  target?: "occurrence" | "deadline";
  reminderId?: string;
  timezone: string;
  reminderMinutes: number;
  type?: "todo" | "birthday" | "anniversary";
  status?: "active" | "completed" | "archived";
  note?: string;
  priority?: "low" | "normal" | "high";
  allDay?: boolean;
  generatedAt?: string;
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
  | { kind: "oilprice.advance_notice"; payload: OilPriceAdvanceNoticePayload }
  | { kind: "oilprice.official_result"; payload: OilPriceOfficialResultPayload }
  | { kind: "schedule.reminder"; payload: ScheduleReminderPayload }
);

export interface RenderedNotification {
  title: string;
  body: string;
}

export type NotificationRenderTarget =
  | "plain"
  | "qq-markdown"
  | "feishu-markdown"
  | "wechat-plain";

export type NotificationRenderer = (
  notification: NotificationEnvelope,
  target?: NotificationRenderTarget,
) => RenderedNotification;

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

function formatBusinessDate(value: string): string {
  return DateTime.fromISO(value, { zone: "Asia/Shanghai" }).toFormat("yyyy年M月d日");
}

function renderOilPriceAdvance(payload: OilPriceAdvanceNoticePayload): string {
  return [
    `调整时间：${formatBusinessDate(payload.windowDate)} 24:00（北京时间）`,
    "正式涨跌：尚未发布",
    `提示：${payload.tip}`,
  ].join("\n");
}

function renderChange(value: string): string {
  if (value.startsWith("-")) return `每升下降${value.slice(1)}元`;
  if (/^0(?:\.0+)?$/.test(value)) return "每升价格不变";
  return `每升上涨${value}元`;
}

function renderOilPriceResult(
  notification: Extract<NotificationEnvelope, { kind: "oilprice.official_result" }>,
): string {
  const { payload, provenance } = notification;
  const effectiveAt = `${formatBusinessDate(payload.windowDate)} 24:00`;
  const lines = ([
    ["92号汽油", payload.fuels.p92],
    ["95号汽油", payload.fuels.p95],
    ["0号柴油", payload.fuels.p0],
  ] as const).map(([label, fuel]) => `${label}：${fuel.current}${payload.unit}，${renderChange(fuel.change)}`);
  lines.push(`生效时间：${effectiveAt}（北京时间）`);
  lines.push(`地区：${payload.province}`);
  const provider = provenance?.provider?.trim();
  const sourceIncludesProvider = provider
    ? payload.source.toLocaleLowerCase().includes(provider.toLocaleLowerCase())
    : false;
  lines.push(`来源：${payload.source}${provider && !sourceIncludesProvider ? `（${provider}）` : ""}`);
  return lines.join("\n");
}

function renderScheduleReminder(payload: ScheduleReminderPayload): string {
  if (!payload.target || !payload.occurrenceAt || !payload.targetAt || !payload.generatedAt) {
    const localEvent = DateTime.fromISO(payload.eventAt, { setZone: true })
      .setZone(payload.timezone)
      .toFormat("yyyy-LL-dd HH:mm");
    return `${payload.title}\n时间：${localEvent}\n提醒：提前 ${payload.reminderMinutes} 分钟`;
  }
  const targetAt = DateTime.fromISO(payload.targetAt, { setZone: true }).setZone(payload.timezone);
  const generatedAt = DateTime.fromISO(payload.generatedAt, { setZone: true }).setZone(payload.timezone);
  const targetLabel = payload.target === "deadline" ? "截止提醒" : "发生提醒";
  const typeLabel = { todo: "待办", birthday: "生日", anniversary: "纪念日" }[payload.type ?? "todo"];
  const firstLine = `${typeLabel} · ${targetLabel}：${payload.title}`;
  const sameDay = targetAt.toISODate() === generatedAt.toISODate();
  const tomorrow = targetAt.toISODate() === generatedAt.plus({ days: 1 }).toISODate();
  const clock = targetAt.toFormat("HH:mm");
  const hideClock = payload.target === "occurrence" && payload.allDay === true;
  let displayTime: string;
  if (sameDay) displayTime = hideClock ? "今天" : `今天 ${clock}`;
  else if (tomorrow) displayTime = hideClock ? "明天" : `明天 ${clock}`;
  else displayTime = targetAt.toFormat(hideClock ? "yyyy-LL-dd" : "yyyy-LL-dd HH:mm");

  const differenceMs = targetAt.toMillis() - generatedAt.toMillis();
  let relative: string;
  if (differenceMs === 0) {
    relative = "现在";
  } else if (differenceMs > 0 && differenceMs < 60_000) {
    relative = "马上";
  } else if (differenceMs > 0 && differenceMs < 24 * 60 * 60 * 1000) {
    const totalMinutes = Math.floor(differenceMs / 60_000);
    relative = `还有 ${Math.floor(totalMinutes / 60)} 小时 ${totalMinutes % 60} 分钟`;
  } else if (differenceMs > 0) {
    const calendarDays = Math.max(1, Math.round(
      targetAt.startOf("day").diff(generatedAt.startOf("day"), "days").days,
    ));
    relative = `还有 ${calendarDays} 天`;
  } else if (-differenceMs < 60 * 60 * 1000) {
    relative = `已逾期 ${Math.max(1, Math.floor(-differenceMs / 60_000))} 分钟`;
  } else if (-differenceMs < 24 * 60 * 60 * 1000) {
    relative = `已逾期 ${Math.floor(-differenceMs / (60 * 60 * 1000))} 小时`;
  } else {
    relative = `已逾期 ${Math.floor(-differenceMs / (24 * 60 * 60 * 1000))} 天`;
  }
  const timeLabel = payload.target === "deadline" ? "截止时间" : "发生时间";
  const lines = [firstLine, `${timeLabel}：${displayTime}`, `相对：${relative}`];
  if (payload.note) lines.push(`备注：${payload.note}`);
  return lines.join("\n");
}

function renderPlainNotification(notification: NotificationEnvelope): RenderedNotification {
  let body: string;
  if (notification.kind === "weather.daily_brief") body = renderDailyWeather(notification.payload);
  else if (notification.kind === "weather.official_alert") body = renderOfficialAlert(notification);
  else if (notification.kind === "oilprice.advance_notice") body = renderOilPriceAdvance(notification.payload);
  else if (notification.kind === "oilprice.official_result") body = renderOilPriceResult(notification);
  else body = renderScheduleReminder(notification.payload);
  return {
    title: notification.headline,
    body,
  };
}

export function renderNotification(
  notification: NotificationEnvelope,
  target: NotificationRenderTarget = "plain",
): RenderedNotification {
  // Platform-specific renderers are intentionally deferred; every target currently uses the stable plain snapshot.
  void target;
  return renderPlainNotification(notification);
}
