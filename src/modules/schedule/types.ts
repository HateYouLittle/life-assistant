export type ScheduleType = "todo" | "birthday" | "anniversary";
export type CalendarType = "solar" | "lunar";
export type Frequency = "once" | "daily" | "weekly" | "monthly" | "yearly" | "workday" | "holiday";
export type LeapMonthPolicy = "normal" | "leap";
export type ScheduleStatus = "active" | "completed" | "archived";
export type Priority = "low" | "normal" | "high";
export type ReminderTarget = "occurrence" | "deadline";

export interface ReminderInput {
  minutesBefore: number;
  id?: string;
  target?: ReminderTarget;
}

export interface RecurrenceRule {
  frequency: Frequency;
  interval: number;
  byWeekday?: string[];
  byMonthDay?: number;
  until?: string;
  count?: number;
  calendar: CalendarType;
  leapMonthPolicy?: LeapMonthPolicy;
}

export interface ScheduleInput {
  /** 导入场景保留原 ID；常规创建忽略 */
  id?: string;
  type?: ScheduleType;
  title: string;
  note?: string;
  priority?: Priority;
  status?: ScheduleStatus;
  calendar: CalendarType;
  date?: string;
  time?: string;
  allDay?: boolean;
  timezone?: string;
  lunarMonth?: number;
  lunarDay?: number;
  isLeapMonth?: boolean;
  leapMonthPolicy?: LeapMonthPolicy;
  recurrence?: Partial<RecurrenceRule> | Frequency;
  reminders?: ReminderInput[];
  deadlineAt?: string;
  deadlineOffsetMinutes?: number;
  clearDeadline?: boolean;
  /** 强提醒重发间隔（分钟，1-10080）；与 maxAttempts 至少传其一即开启强提醒，缺省 120 */
  intervalMinutes?: number;
  /** 最多重提醒轮数（1-99）；与 intervalMinutes 至少传其一即开启强提醒，缺省 3 */
  maxAttempts?: number;
}

export interface ScheduleItem {
  id: string;
  profileId: string;
  type: ScheduleType;
  title: string;
  note?: string;
  priority: Priority;
  status: ScheduleStatus;
  calendar: CalendarType;
  date?: string;
  time: string;
  allDay: boolean;
  timezone: string;
  lunarMonth?: number;
  lunarDay?: number;
  isLeapMonth?: boolean;
  recurrence: RecurrenceRule;
  reminders: ReminderInput[];
  deadlineAt?: string;
  deadlineOffsetMinutes?: number;
  /** 强提醒重发间隔（分钟）；undefined = 未开启强提醒 */
  reminderIntervalMinutes?: number;
  /** 最多重提醒轮数；undefined = 未开启强提醒 */
  reminderMaxAttempts?: number;
  enabled: boolean;
  nextRunAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nextOccurrenceSolar?: string;
}

export interface ScheduleListOptions {
  type?: ScheduleType;
  status?: ScheduleStatus;
  from?: string;
  to?: string;
  upcoming?: number;
}
