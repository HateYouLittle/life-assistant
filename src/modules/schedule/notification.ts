import { DateTime } from "luxon";
import {
  registerNotificationBlocks,
  renderNotification,
  type EnvelopeFor,
  type RenderBlock,
} from "../../core/notification.js";
import {
  registerDeliveryRerender,
  deliveryDeferralReason,
  parseDeliveryEnvelope,
} from "../../core/delivery-render.js";
import { config, resolveRenderTarget } from "../../config.js";
import type { ReminderTarget, ScheduleItem } from "./types.js";

// ---------------------------------------------------------------------------
// 载荷与渲染归本模块所有；core 只保留信封骨架与投影管道。
// ---------------------------------------------------------------------------

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
  /** 投递时由投递期钩子附加：本次推送晚于提醒触发时刻的原因（如勿扰时段顺延）。 */
  deferralReason?: string;
}

export type ScheduleReminderEnvelope = EnvelopeFor<"schedule.reminder", ScheduleReminderPayload>;

export interface ScheduleReminderNotificationInput {
  item: ScheduleItem;
  occurrenceKey: string;
  occurrenceAt: string;
  deadlineAt?: string;
  target: ReminderTarget;
  reminderId: string;
  reminderMinutes: number;
  generatedAt: string;
}

export function buildScheduleReminderNotification({
  item,
  occurrenceKey,
  occurrenceAt,
  deadlineAt,
  target,
  reminderId,
  reminderMinutes,
  generatedAt,
}: ScheduleReminderNotificationInput): ScheduleReminderEnvelope {
  const typeLabel = { todo: "待办", birthday: "生日", anniversary: "纪念日" }[item.type];
  const targetLabel = target === "deadline" ? "截止提醒" : "发生提醒";
  const targetAt = target === "deadline" ? deadlineAt : occurrenceAt;
  if (!targetAt) throw new Error("deadline reminder requires deadlineAt");
  return {
    kind: "schedule.reminder",
    identity: `${item.profileId}:${item.id}:${occurrenceKey}`,
    source: "schedule",
    scope: { type: "profile", profileId: item.profileId },
    headline: `${typeLabel} · ${targetLabel}：${item.title}`,
    generatedAt,
    payload: {
      title: item.title,
      eventAt: occurrenceAt,
      occurrenceAt,
      ...(deadlineAt ? { deadlineAt } : {}),
      targetAt,
      target,
      reminderId,
      timezone: item.timezone,
      reminderMinutes,
      type: item.type,
      status: item.status,
      ...(item.note ? { note: item.note } : {}),
      priority: item.priority,
      allDay: item.allDay,
      generatedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// RenderBlock[] 构造器（自 core/notification.ts 下放，逻辑逐行保留）
// ---------------------------------------------------------------------------

function scheduleReminderBlocks(rawPayload: unknown): RenderBlock[] {
  const payload = rawPayload as ScheduleReminderPayload;
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
  if (payload.deferralReason) relative = `${relative}（${payload.deferralReason}）`;
  const timeLabel = payload.target === "deadline" ? "截止时间" : "发生时间";
  const blocks: RenderBlock[] = [
    { type: "line", text: firstLine },
    { type: "label", label: timeLabel, value: displayTime },
    { type: "label", label: "相对", value: relative },
  ];
  if (payload.note) blocks.push({ type: "label", label: "备注", value: payload.note });
  return blocks;
}

registerNotificationBlocks("schedule.reminder", (n) => scheduleReminderBlocks(n.payload));

// ---------------------------------------------------------------------------
// 投递期重渲染（方案 A 的 schedule 实现部分）。
//
// 快照里的"相对"行以发布时刻计算，勿扰顺延/重试/停机补发后推送会带着过期的
// 相对时间。发布时同步落了一份结构化 envelope（v6 envelope 列），投递时按投递
// 时刻重算相对时间，并在推送晚于提醒触发时刻时附加原因。其他模块未注册钩子，
// 维持"快照即投递"契约。
// ---------------------------------------------------------------------------

/** 投递参考时间的抖动容差：与 scheduler 发布参考时间的口径一致（60 秒）。 */
const DELIVERY_RENDER_TOLERANCE_MS = 60_000;

registerDeliveryRerender((row, at) => {
  const envelope = parseDeliveryEnvelope(row);
  if (!envelope || envelope.kind !== "schedule.reminder") return undefined;
  const payload = envelope.payload as ScheduleReminderPayload;
  if (!payload.targetAt || !payload.generatedAt) return undefined;
  const targetMs = Date.parse(payload.targetAt);
  const firedAtMs = Date.parse(payload.generatedAt);
  if (!Number.isFinite(targetMs) || !Number.isFinite(firedAtMs)) return undefined;
  const nowMs = at.getTime();
  // 亚分钟内的"逾期"钉回目标时刻：即时投递的抖动显示"现在"而非"已逾期 1 分钟"。
  const referenceMs = nowMs >= targetMs && nowMs - targetMs <= DELIVERY_RENDER_TOLERANCE_MS
    ? targetMs
    : nowMs;
  const reference = new Date(referenceMs).toISOString();
  const reason = deliveryDeferralReason({
    profileId: row.profileId,
    firedAt: payload.generatedAt,
    notBefore: row.notBefore,
    attempts: row.attempts,
  });
  const reRendered = {
    ...envelope,
    generatedAt: reference,
    payload: {
      ...payload,
      generatedAt: reference,
      ...(reason ? { deferralReason: reason } : {}),
    },
  };
  try {
    const route = Object.prototype.hasOwnProperty.call(config.profilePushRoutes, row.profileId)
      ? config.profilePushRoutes[row.profileId]
      : undefined;
    return renderNotification(reRendered, resolveRenderTarget(route) ?? "plain");
  } catch {
    return undefined;
  }
});
