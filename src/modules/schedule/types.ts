export type ScheduleType = "todo" | "birthday" | "anniversary";
export type CalendarType = "solar" | "lunar";
export type Frequency = "once" | "daily" | "weekly" | "monthly" | "yearly";
export type LeapMonthPolicy = "normal" | "leap" | "both" | "prefer-leap";
export type ScheduleStatus = "active" | "completed" | "archived";
export type Priority = "low" | "normal" | "high";

export interface ReminderInput {
  minutesBefore: number;
  id?: string;
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
