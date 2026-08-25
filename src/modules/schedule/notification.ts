import type { NotificationEnvelope, ScheduleReminderPayload } from "../../core/notification.js";
import type { ReminderTarget, ScheduleItem } from "./types.js";

export interface ScheduleReminderNotificationInput {
  item: ScheduleItem;
  occurrenceKey: string;
  occurrenceAt: string;
  deadlineAt?: string;
  target: ReminderTarget;
  reminderId: string;
  reminderMinutes: number;
  generatedAt: string;
  /** 强提醒重发轮次（attempt-N）；正式提醒不传。 */
  attemptN?: number;
}

/** schedule.reminder 信封：payload 附加强提醒轮次字段（仅重发通知存在），结构不破坏 delivery-render。 */
export type ScheduleReminderNotification = Extract<NotificationEnvelope, { kind: "schedule.reminder" }> & {
  payload: ScheduleReminderPayload & { attemptN?: number; maxAttempts?: number };
};

export function buildScheduleReminderNotification({
  item,
  occurrenceKey,
  occurrenceAt,
  deadlineAt,
  target,
  reminderId,
  reminderMinutes,
  generatedAt,
  attemptN,
}: ScheduleReminderNotificationInput): ScheduleReminderNotification {
  const typeLabel = { todo: "待办", birthday: "生日", anniversary: "纪念日" }[item.type];
  const targetLabel = target === "deadline" ? "截止提醒" : "发生提醒";
  const targetAt = target === "deadline" ? deadlineAt : occurrenceAt;
  if (!targetAt) throw new Error("deadline reminder requires deadlineAt");
  // P3-5：重发通知在标题标注轮次（含总次数），与正式提醒（不传 attemptN）可区分；
  // title/body 均带标记（body 首行由 payload.title 渲染），envelope 另附结构化轮次字段。
  const attemptSuffix = attemptN !== undefined && item.reminderMaxAttempts !== undefined
    ? `（第 ${attemptN} 次提醒，共 ${item.reminderMaxAttempts} 次）`
    : "";
  return {
    kind: "schedule.reminder",
    identity: `${item.profileId}:${item.id}:${occurrenceKey}`,
    source: "schedule",
    scope: { type: "profile", profileId: item.profileId },
    headline: `${typeLabel} · ${targetLabel}：${item.title}${attemptSuffix}`,
    generatedAt,
    payload: {
      title: attemptN !== undefined ? `${item.title}${attemptSuffix}` : item.title,
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
      ...(attemptN !== undefined ? { attemptN, maxAttempts: item.reminderMaxAttempts } : {}),
    },
  };
}
