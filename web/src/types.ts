// Location
export interface LocationInfo {
  city: string;
  lat: number;
  lon: number;
  province?: string;
}

// Weather
export interface CurrentWeather {
  temperature: number;
  apparent: number;
  humidity: number;
  windSpeed: number;
  windSpeedUnit: "km/h" | "m/s";
  weatherText: string;
}

export interface ForecastDay {
  date: string;
  tMax: number;
  tMin: number;
  weatherText: string;
  precipProb?: number;
  precipAmountMm?: number;
}

export interface AirQuality {
  city: string;
  scale: "CN" | "US";
  aqi: number;
  category: string;
  primary?: string;
  pollutants: {
    pm25?: number;
    pm10?: number;
    o3?: number;
    no2?: number;
    so2?: number;
  };
  observedAt?: string;
  source: string;
}

export interface OfficialWeatherAlert {
  kind: "official";
  id?: string;
  publisher?: string;
  issuedAt?: string;
  eventType: string;
  eventCode?: string;
  level?: string;
  severity?: string;
  effectiveAt?: string;
  onsetAt?: string;
  expiresAt?: string;
  headline: string;
  description: string;
  criteria?: string;
  instruction?: string;
  attributions: string[];
}

export interface InferredWeatherRisk {
  kind: "inferred";
  title: string;
  level: "inferred";
  description: string;
}

export type WeatherAlert = OfficialWeatherAlert | InferredWeatherRisk;

export interface LifeIndex {
  name: string;
  category: string;
  level?: string;
  text?: string;
}

export interface WeatherData {
  error?: string;
  location: LocationInfo | null;
  current: CurrentWeather | null;
  forecast: ForecastDay[] | null;
  airQuality: AirQuality | null;
  alerts: WeatherAlert[] | null;
  indices: LifeIndex[] | null;
}

// Oil Price
export interface CurrentOilPriceResult {
  region: string;
  p92: string;
  p95: string;
  p0: string;
  updatedAt?: string;
}

export interface NextAdjustmentSummary {
  date: string;
  effectiveAt: string;
  hoursUntil: number;
  daysUntil?: number;
  calibrated?: boolean;
  note?: string;
}

export interface OilPriceData {
  location: LocationInfo | null;
  current: CurrentOilPriceResult | null;
  nextAdjustment: NextAdjustmentSummary | null;
}

// Holiday
export interface DayInfo {
  date: string;
  isWorkday: boolean;
  isHoliday: boolean;
  dayType?: "workday" | "holiday";
  name?: string;
  note?: string;
}

export interface MakeUpWorkday {
  date: string;
  name: string;
}

export interface HolidayPeriod {
  name: string;
  startDate: string;
  endDate: string;
  days: number;
  makeUpWorkdays: MakeUpWorkday[];
}

export interface HolidayYearView {
  year: number;
  periods: HolidayPeriod[];
  workdays: MakeUpWorkday[];
}

export interface NextHolidayResult {
  status: "ongoing" | "upcoming" | "unknown";
  today: string;
  holidayName?: string;
  startDate?: string;
  endDate?: string;
  days?: number;
  countdownDays?: number;
  remainingDays?: number;
  makeUpWorkdays?: MakeUpWorkday[];
  coveredUntil?: string;
  message?: string;
}

export interface HolidayData {
  today: DayInfo | null;
  next: NextHolidayResult | null;
  year: HolidayYearView | null;
}

// Schedule
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
  reminderIntervalMinutes?: number;
  reminderMaxAttempts?: number;
  enabled: boolean;
  nextRunAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nextOccurrenceSolar?: string;
}

export interface ScheduleData {
  profile: string;
  total: number;
  items: ScheduleItem[];
}

// Bookkeeping
export type LedgerType = "personal" | "shared";
export type LedgerRole = "owner" | "member";
export type AccountKind = "personal" | "shared";
export type EntryType = "expense" | "income" | "transfer";
export type AccountType = "cash" | "bank" | "alipay" | "wechat" | "other";

export interface AccountView {
  id: string;
  kind: AccountKind;
  name: string;
  type: AccountType;
  archived: boolean;
  balanceCents: number;
  ownerProfileId?: string;
  ledgerId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryTotal {
  category: string;
  amountCents: number;
}

export interface AccountBalanceView {
  id: string;
  name: string;
  type: AccountType;
  kind: AccountKind;
  archived: boolean;
  balanceCents: number;
}

export interface SummaryView {
  ledgerId: string;
  ledgerName: string;
  month: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  entryCount: number;
  expenseByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  accounts: AccountBalanceView[];
}

export interface LedgerEntry {
  ledgerId: string;
  id: string;
  profileId: string;
  type: EntryType;
  amountCents: number;
  category?: string;
  accountId?: string;
  toAccountId?: string;
  occurredAt: string;
  note?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerView {
  id: string;
  type: LedgerType;
  name: string;
  ownerProfileId: string;
  role: LedgerRole;
  memberCount: number;
  accountCount: number;
  totalBalanceCents: number;
  createdAt: string;
}

export interface BookkeepingData {
  profile: string;
  accounts: AccountView[];
  summary: SummaryView;
  entries: LedgerEntry[];
  ledgers: LedgerView[];
}

// Automation
export type AutomationConditionOp = ">" | ">=" | "<" | "<=" | "==" | "!=";

export interface AutomationCondition {
  field: string;
  op: AutomationConditionOp;
  value: number | string;
}

export type AutomationSchedule =
  | { type: "daily"; time: string; timezone: string }
  | { type: "interval"; minutes: number };

export interface AutomationItem {
  id: string;
  profileId: string;
  name: string;
  action: string;
  params: Record<string, unknown>;
  condition?: AutomationCondition;
  schedule: AutomationSchedule;
  enabled: boolean;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationsData {
  profile: string;
  total: number;
  items: AutomationItem[];
}

// Quiet Hours
export interface QuietHours {
  start: string;
  end: string;
  timezone: string;
}

// Health
export interface HealthData {
  status: string;
  timestamp: string;
  profile: string;
}

// Overview
export interface OverviewData {
  profile: string;
  location: LocationInfo | null;
  calendar: {
    today: DayInfo | null;
    nextHoliday: NextHolidayResult | null;
  };
  weather: {
    current: CurrentWeather | null;
    forecast: ForecastDay[] | null;
  } | null;
  oilprice: {
    current: CurrentOilPriceResult | null;
    nextAdjustment: NextAdjustmentSummary | null;
  } | null;
  schedules: {
    activeCount: number;
  };
  bookkeeping: {
    summary: SummaryView | null;
  };
  quietHours: QuietHours | null;
}
