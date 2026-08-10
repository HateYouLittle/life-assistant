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
  | "wechat-markdown";

export type NotificationRenderer = (
  notification: NotificationEnvelope,
  target?: NotificationRenderTarget,
) => RenderedNotification;

// ============================================================================
// 阶段 B：结构化块中间表示（RenderBlock[] IR）
//
// plain / qq-markdown / feishu-markdown / wechat-markdown 都是同一份 RenderBlock[]
// 的确定性投影：qq/feishu/wechat 三平台统一同一套保守 markdown 渲染规则，plain 为兜底。
// 官方原文（details 字段）一律走 raw 块：原样输出、永不被解析/转义。
// plain 投影必须与阶段 A 黄金样例逐字节一致（硬约束）。
// ============================================================================

export type RenderBlock =
  | { type: "line"; text: string }
  | { type: "label"; label: string; value: string }
  | { type: "section"; title?: string }
  | { type: "raw"; text: string };

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
  if (payload.advice) blocks.push({ type: "label", label: "建议", value: payload.advice });
  return blocks;
}

function formatDateTime(value: string, timezone: string): string {
  return DateTime.fromISO(value, { setZone: true }).setZone(timezone).toFormat("yyyy年M月d日 HH:mm");
}

function officialAlertBlocks(
  notification: Extract<NotificationEnvelope, { kind: "weather.official_alert" }>,
): RenderBlock[] {
  const { payload, provenance } = notification;
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

function formatBusinessDate(value: string): string {
  return DateTime.fromISO(value, { zone: "Asia/Shanghai" }).toFormat("yyyy年M月d日");
}

function oilPriceAdvanceBlocks(payload: OilPriceAdvanceNoticePayload): RenderBlock[] {
  return [
    { type: "label", label: "调整时间", value: `${formatBusinessDate(payload.windowDate)} 24:00（北京时间）` },
    { type: "label", label: "正式涨跌", value: "尚未发布" },
    { type: "label", label: "提示", value: payload.tip },
  ];
}

function renderChange(value: string): string {
  if (value.startsWith("-")) return `每升下降${value.slice(1)}元`;
  if (/^0(?:\.0+)?$/.test(value)) return "每升价格不变";
  return `每升上涨${value}元`;
}

function oilPriceResultBlocks(
  notification: Extract<NotificationEnvelope, { kind: "oilprice.official_result" }>,
): RenderBlock[] {
  const { payload, provenance } = notification;
  const effectiveAt = `${formatBusinessDate(payload.windowDate)} 24:00`;
  const blocks: RenderBlock[] = ([
    ["92号汽油", payload.fuels.p92],
    ["95号汽油", payload.fuels.p95],
    ["0号柴油", payload.fuels.p0],
  ] as const).map(([label, fuel]) => ({
    type: "label",
    label,
    value: `${fuel.current}${payload.unit}，${renderChange(fuel.change)}`,
  } as const));
  blocks.push({ type: "label", label: "生效时间", value: `${effectiveAt}（北京时间）` });
  blocks.push({ type: "label", label: "地区", value: payload.province });
  const provider = provenance?.provider?.trim();
  const sourceIncludesProvider = provider
    ? payload.source.toLocaleLowerCase().includes(provider.toLocaleLowerCase())
    : false;
  blocks.push({
    type: "label",
    label: "来源",
    value: `${payload.source}${provider && !sourceIncludesProvider ? `（${provider}）` : ""}`,
  });
  return blocks;
}

function scheduleReminderBlocks(payload: ScheduleReminderPayload): RenderBlock[] {
  if (!payload.target || !payload.occurrenceAt || !payload.targetAt || !payload.generatedAt) {
    const localEvent = DateTime.fromISO(payload.eventAt, { setZone: true })
      .setZone(payload.timezone)
      .toFormat("yyyy-LL-dd HH:mm");
    return [
      { type: "line", text: payload.title },
      { type: "label", label: "时间", value: localEvent },
      { type: "label", label: "提醒", value: `提前 ${payload.reminderMinutes} 分钟` },
    ];
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
  const blocks: RenderBlock[] = [
    { type: "line", text: firstLine },
    { type: "label", label: timeLabel, value: displayTime },
    { type: "label", label: "相对", value: relative },
  ];
  if (payload.note) blocks.push({ type: "label", label: "备注", value: payload.note });
  return blocks;
}

function renderBlocks(notification: NotificationEnvelope): RenderBlock[] {
  if (notification.kind === "weather.daily_brief") return dailyWeatherBlocks(notification.payload);
  if (notification.kind === "weather.official_alert") return officialAlertBlocks(notification);
  if (notification.kind === "oilprice.advance_notice") return oilPriceAdvanceBlocks(notification.payload);
  if (notification.kind === "oilprice.official_result") return oilPriceResultBlocks(notification);
  return scheduleReminderBlocks(notification.payload);
}

// ---------------------------------------------------------------------------
// plain 投影：与阶段 A 黄金样例逐字节一致（join("\n") 语义，section → 空行）。
// ---------------------------------------------------------------------------

function blockToPlain(block: RenderBlock): string {
  switch (block.type) {
    case "line":
      return block.text;
    case "label":
      return `${block.label}：${block.value}`;
    case "section":
      return "";
    case "raw":
      return block.text;
  }
}

function renderPlainBlocks(blocks: RenderBlock[]): string {
  return blocks.map(blockToPlain).join("\n");
}

function renderPlainNotification(notification: NotificationEnvelope): RenderedNotification {
  return {
    title: notification.headline,
    body: renderPlainBlocks(renderBlocks(notification)),
  };
}

// ---------------------------------------------------------------------------
// markdown 投影：qq-markdown / feishu-markdown / wechat-markdown 三平台统一同一套保守渲染规则（D6）。
//   - 标题 → `# headline`（放进 title）；
//   - label 块 → `**标签**：值`；
//   - 块间空行（\n\n）；
//   - raw 块原样输出，不解析不转义（D7）；
//   - 省略与 headline 完全相同的首行（D2）。
// 禁止表格/列表/emoji/引用。
// ---------------------------------------------------------------------------

function blockToMarkdown(block: RenderBlock): string {
  switch (block.type) {
    case "line":
      return block.text;
    case "label":
      return `**${block.label}**：${block.value}`;
    case "section":
      return "";
    case "raw":
      return block.text;
  }
}

function renderMarkdownBlocks(blocks: RenderBlock[], headline: string): string {
  const parts: string[] = [];
  let isFirst = true;
  for (const block of blocks) {
    if (isFirst && block.type === "line" && block.text === headline) {
      isFirst = false;
      continue;
    }
    isFirst = false;
    if (block.type === "section") continue;
    parts.push(blockToMarkdown(block));
  }
  return parts.join("\n\n");
}

function renderMarkdownNotification(notification: NotificationEnvelope): RenderedNotification {
  return {
    title: `# ${notification.headline}`,
    body: renderMarkdownBlocks(renderBlocks(notification), notification.headline),
  };
}

export function renderNotification(
  notification: NotificationEnvelope,
  target: NotificationRenderTarget = "plain",
): RenderedNotification {
  if (target === "qq-markdown" || target === "feishu-markdown" || target === "wechat-markdown") {
    try {
      return renderMarkdownNotification(notification);
    } catch {
      // 平台分支任何异常都回退 plain 兜底，不允许 throw。
      return renderPlainNotification(notification);
    }
  }
  // plain | 未知/非法 target → plain 兜底投影。
  return renderPlainNotification(notification);
}
