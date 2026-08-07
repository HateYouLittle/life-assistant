import type { NotificationEnvelope } from "../../core/notification.js";
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
}: ScheduleReminderNotificationInput): Extract<NotificationEnvelope, { kind: "schedule.reminder" }> {
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
