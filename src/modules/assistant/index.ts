import { z } from "zod";
import { registerModule, ok, withTool, type AssistantModule } from "../../core/registry.js";
import { requireProfileContext, type ProfileContext } from "../../core/profile.js";
import { getDatabase } from "../../core/database.js";
import { currentLocation, saveImportedLocation } from "../location/index.js";
import { getQuietHours, saveQuietHours, validateQuietHours } from "../../core/notification-settings.js";
import {
  createSchedule,
  getSchedule,
  hydrateRow,
} from "../schedule/service.js";
import type { ScheduleItem } from "../schedule/types.js";
import { createAutomation, getAutomation, type AutomationCreateInput } from "../automation/service.js";
import { automationScheduleSchema } from "../automation/service.js";

export const EXPORT_FORMAT = "life-assistant.export";
/**
 * 导出快照格式版本：v1（无强提醒字段，intervalMinutes/maxAttempts 缺失 = 未开启）→
 * v2（含可选 intervalMinutes/maxAttempts，导入恢复强提醒）。仅影响导出文件格式，
 * 不动 DB schema（保持 v7）。
 */
export const EXPORT_VERSION = 2;
/** 单类条目导出上限；超过时快照带 truncated 标记，导入方应提示用户分批处理。 */
export const EXPORT_ROW_LIMIT = 1000;

/** 可移植日程条目：ScheduleItem 去掉运行时派生字段（profileId/version/enabled/nextRunAt 等）。 */
export interface PortableSchedule {
  id: string;
  type?: ScheduleItem["type"];
  title: string;
  note?: string;
  priority?: ScheduleItem["priority"];
  status?: ScheduleItem["status"];
  calendar: ScheduleItem["calendar"];
  date?: string;
  time?: string;
  allDay?: boolean;
  timezone?: string;
  lunarMonth?: number;
  lunarDay?: number;
  isLeapMonth?: boolean;
  leapMonthPolicy?: ScheduleItem["recurrence"]["leapMonthPolicy"];
  recurrence?: ScheduleItem["recurrence"];
  reminders?: ScheduleItem["reminders"];
  deadlineAt?: string;
  deadlineOffsetMinutes?: number;
  /** 强提醒重发间隔（分钟，1-10080）；v2 快照字段，v1 缺省 = 未开启 */
  intervalMinutes?: number;
  /** 最多重提醒轮数（1-99）；v2 快照字段，v1 缺省 = 未开启 */
  maxAttempts?: number;
}

/** 导出侧 JSON 列容错：单行损坏不得拖垮整个导出（对照 schedule parseJson 的容错口径）。 */
function parseSnapshotJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 可空 JSON 列解析：区分「列为 NULL（合法，无值）」与「列存在但 JSON 损坏」。
 * 后者由调用方按行级损坏处理（跳过并计数），不得静默降级成缺省值——
 * 例如 condition 损坏若导出成 undefined，导入后会变成「到点必提醒」，语义漂移。
 */
function parseNullableJsonColumn(value: unknown): { value: unknown; corrupt: boolean } {
  if (value == null) return { value: undefined, corrupt: false };
  if (typeof value !== "string") return { value: undefined, corrupt: true };
  try {
    return { value: JSON.parse(value) as unknown, corrupt: false };
  } catch {
    return { value: undefined, corrupt: true };
  }
}

function toPortableSchedule(item: ScheduleItem): PortableSchedule {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    note: item.note,
    priority: item.priority,
    status: item.status,
    calendar: item.calendar,
    date: item.date,
    time: item.time,
    allDay: item.allDay,
    timezone: item.timezone,
    lunarMonth: item.lunarMonth,
    lunarDay: item.lunarDay,
    isLeapMonth: item.isLeapMonth,
    leapMonthPolicy: item.recurrence.leapMonthPolicy,
    recurrence: item.recurrence,
    reminders: item.reminders,
    deadlineAt: item.deadlineAt,
    deadlineOffsetMinutes: item.deadlineOffsetMinutes,
    ...(item.reminderIntervalMinutes !== undefined ? { intervalMinutes: item.reminderIntervalMinutes } : {}),
    ...(item.reminderMaxAttempts !== undefined ? { maxAttempts: item.reminderMaxAttempts } : {}),
  };
}

export interface AssistantExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  profile: string;
  data: {
    schedules: PortableSchedule[];
    automations: Array<Omit<AutomationCreateInput, "schedule"> & { schedule: AutomationCreateInput["schedule"] }>;
    quietHours: { start: string; end: string; timezone: string } | null;
    location: { city: string; province?: string; lat: number; lon: number } | null;
    /** 任一类条目超过导出上限时为 true：快照不完整，导入方应提示 */
    truncated?: boolean;
    /** 因 JSON 列损坏被跳过的自动任务行数（>0 时快照缺少这些任务，导入方应提示） */
    invalidAutomations?: number;
  };
}

export function buildAssistantExport(profile: ProfileContext): AssistantExport {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT * FROM schedules WHERE profile_id = ? ORDER BY created_at, id LIMIT ?",
  ).all(profile.id, EXPORT_ROW_LIMIT + 1) as Array<Record<string, unknown>>;
  const automations = db.prepare(
    "SELECT * FROM automations WHERE profile_id = ? ORDER BY created_at, id LIMIT ?",
  ).all(profile.id, EXPORT_ROW_LIMIT + 1) as Array<Record<string, unknown>>;
  const schedulesTruncated = rows.length > EXPORT_ROW_LIMIT;
  const automationsTruncated = automations.length > EXPORT_ROW_LIMIT;
  const quiet = getQuietHours(profile.id);
  const loc = currentLocation();
  // L10：单行 JSON 列损坏不得让 JSON.parse 抛出拖垮整个导出（对照 schedule/service.ts
  // parseJson 容错）。params 损坏降级为 {}（导入侧 paramsSchema 校验兜底）；
  // condition/schedule 损坏按行跳过并计入 invalidAutomations（语义不可静默降级）。
  const exportedAutomations: AssistantExport["data"]["automations"] = [];
  let invalidAutomationRows = 0;
  for (const row of automations.slice(0, EXPORT_ROW_LIMIT)) {
    const params = parseSnapshotJson(String(row.params_json ?? "{}"), {}) as Record<string, unknown>;
    const conditionColumn = parseNullableJsonColumn(row.condition_json);
    const schedule = parseSnapshotJson(
      String(row.schedule_json),
      undefined as AutomationCreateInput["schedule"] | undefined,
    );
    // schedule 列损坏无法还原调度、condition 列损坏会让导入后的任务从「条件触发」
    // 漂移成「到点必提醒」：两者都与 params 损坏同口径跳过该行并计入 invalidAutomations。
    if (schedule === undefined || conditionColumn.corrupt) {
      invalidAutomationRows += 1;
      continue;
    }
    exportedAutomations.push({
      id: String(row.id),
      name: String(row.name),
      action: String(row.action),
      params,
      condition: conditionColumn.value as AutomationCreateInput["condition"],
      schedule,
      enabled: Number(row.enabled) === 1,
    });
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    profile: profile.id,
    data: {
      schedules: rows.slice(0, EXPORT_ROW_LIMIT).map((row) => toPortableSchedule(hydrateRow(row))),
      automations: exportedAutomations,
      quietHours: quiet ? { start: quiet.start, end: quiet.end, timezone: quiet.timezone } : null,
      location: loc ? { city: loc.city, province: loc.province, lat: loc.lat, lon: loc.lon } : null,
      truncated: schedulesTruncated || automationsTruncated,
      ...(invalidAutomationRows > 0 ? { invalidAutomations: invalidAutomationRows } : {}),
    },
  };
}

const portableScheduleSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["todo", "birthday", "anniversary"]).optional(),
  title: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  status: z.enum(["active", "completed", "archived"]).optional(),
  calendar: z.enum(["solar", "lunar"]),
  date: z.string().optional(),
  time: z.string().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  lunarMonth: z.number().int().min(1).max(12).optional(),
  lunarDay: z.number().int().min(1).max(30).optional(),
  isLeapMonth: z.boolean().optional(),
  leapMonthPolicy: z.enum(["normal", "leap"]).optional(),
  recurrence: z.unknown().optional(),
  reminders: z.array(z.object({
    id: z.string().optional(),
    minutesBefore: z.number().int().min(0).max(525600),
    target: z.enum(["occurrence", "deadline"]).optional(),
  })).optional(),
  deadlineAt: z.string().optional(),
  deadlineOffsetMinutes: z.number().int().min(0).max(525600).optional(),
  intervalMinutes: z.number().int().min(1).max(10080).optional(),
  maxAttempts: z.number().int().min(1).max(99).optional(),
});

const portableAutomationSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  action: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).optional(),
  condition: z.object({
    field: z.string().min(1).max(100),
    op: z.enum([">", ">=", "<", "<=", "==", "!="]),
    value: z.union([z.number(), z.string()]),
  }).optional(),
  schedule: automationScheduleSchema,
  enabled: z.boolean().optional(),
});

const SUPPORTED_EXPORT_VERSIONS = [1, 2] as const;

const exportPayloadSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.union([z.literal(1), z.literal(2)]),
  data: z.object({
    // 导出侧单类型截断到 1000 条，导入侧同样封顶：防止超大/恶意快照长时间
    // 占住 MCP 调用（每条都有 SELECT+INSERT）并膨胀共享 SQLite。
    schedules: z.array(z.unknown()).max(1000).optional(),
    automations: z.array(z.unknown()).max(1000).optional(),
    quietHours: z.object({
      start: z.string(),
      end: z.string(),
      timezone: z.string(),
    }).nullable().optional(),
    location: z.object({
      city: z.string().min(1).max(64),
      province: z.string().optional(),
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    }).nullable().optional(),
    truncated: z.boolean().optional(),
  }),
});

export interface ImportSummary {
  schedules: { imported: number; skipped: number; invalid: number };
  automations: { imported: number; skipped: number; invalid: number };
  quietHoursApplied: boolean;
  locationApplied: boolean;
}

export function importAssistantExport(
  profile: ProfileContext,
  payload: unknown,
  options: { applyLocation?: boolean } = {},
): ImportSummary {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("导入内容不是有效的快照对象");
  }
  const head = payload as { format?: unknown; version?: unknown };
  if (head.format !== EXPORT_FORMAT) {
    throw new Error(`导入内容不是 ${EXPORT_FORMAT} 快照`);
  }
  // 前置版本检查给出可读错误；schema 的 z.union 再做一层防御。
  // v1 快照无强提醒字段（导入后强提醒未开启）；v2 含 intervalMinutes/maxAttempts。
  if (!SUPPORTED_EXPORT_VERSIONS.includes(head.version as (typeof SUPPORTED_EXPORT_VERSIONS)[number])) {
    throw new Error(`不支持的快照版本 ${String(head.version)}（当前支持版本 1-${EXPORT_VERSION}）`);
  }
  const parsed = exportPayloadSchema.parse(payload);
  // M6：quietHours 在任何写入之前预校验。saveQuietHours 对非法时区/时间格式 throw，
  // 若放在导入循环之后，会出现「部分条目已落库 + 整体报错」，且 ImportSummary 丢失。
  if (parsed.data.quietHours) {
    const { start, end, timezone } = parsed.data.quietHours;
    validateQuietHours(start, end, timezone);
  }
  const summary: ImportSummary = {
    schedules: { imported: 0, skipped: 0, invalid: 0 },
    automations: { imported: 0, skipped: 0, invalid: 0 },
    quietHoursApplied: false,
    locationApplied: false,
  };

  for (const raw of parsed.data.schedules ?? []) {
    const candidate = portableScheduleSchema.safeParse(raw);
    if (!candidate.success) {
      summary.schedules.invalid += 1;
      continue;
    }
    const entry = candidate.data;
    try {
      getSchedule(profile, entry.id);
      summary.schedules.skipped += 1;
      continue;
    } catch { /* 不存在则继续导入 */ }
    try {
      const { id, recurrence, ...rest } = entry;
      // status（含 completed/archived）随 createSchedule 一步落库：normalizeInput 接受
      // 三种状态且派生逻辑一致，消除「先建 active 再补 update」的瞬态窗口——两步之间
      // scheduler tick 可能对即将被标记 completed/archived 的日程发布窗口内补发提醒。
      // rest 含 v2 的 intervalMinutes/maxAttempts（v1 无此键 = 未开启），
      // 直接透传给 createSchedule 恢复强提醒配置。
      createSchedule(profile, {
        ...rest,
        id,
        recurrence: recurrence as PortableSchedule["recurrence"],
      });
      summary.schedules.imported += 1;
    } catch {
      summary.schedules.invalid += 1;
    }
  }

  for (const raw of parsed.data.automations ?? []) {
    const candidate = portableAutomationSchema.safeParse(raw);
    if (!candidate.success) {
      summary.automations.invalid += 1;
      continue;
    }
    const entry = candidate.data;
    try {
      getAutomation(profile, entry.id);
      summary.automations.skipped += 1;
      continue;
    } catch { /* 不存在则继续导入 */ }
    try {
      createAutomation(profile, entry);
      summary.automations.imported += 1;
    } catch {
      summary.automations.invalid += 1;
    }
  }

  if (parsed.data.quietHours) {
    const { start, end, timezone } = parsed.data.quietHours;
    saveQuietHours(profile.id, start, end, timezone);
    summary.quietHoursApplied = true;
  }

  if (options.applyLocation && parsed.data.location) {
    saveImportedLocation(parsed.data.location);
    summary.locationApplied = true;
  }

  return summary;
}

const assistantModule: AssistantModule = {
  name: "assistant",
  tools: [
    withTool(
      {
        name: "export",
        description: "导出当前 Profile 的数据快照（日程全量含状态与强提醒配置、自动任务、静默时段和共享位置）为 JSON，用于备份或迁移。返回的 JSON 可原样传给 assistant.import。导出不包含通知历史与 Webhook secret。单类条目超过 1000 条时 truncated=true，快照不完整，应提示用户。",
      },
      {},
      (_args, context) => ok(buildAssistantExport(context ?? requireProfileContext())),
    ),
    withTool(
      {
        name: "import",
        description: "导入 assistant.export 生成的快照（支持 v1/v2：v1 无强提醒字段、导入后强提醒未开启；v2 恢复 intervalMinutes/maxAttempts）：日程/自动任务按 ID 幂等导入（已存在的跳过，不覆盖），静默时段直接应用；applyLocation=true 时才覆盖共享位置（多 Profile 共享位置，默认不动）。非法条目跳过并计入 invalid；快照带 truncated=true 时应向用户说明数据不完整。",
      },
      {
        data: z.unknown().describe("assistant.export 返回的快照对象"),
        applyLocation: z.boolean().optional().describe("是否用快照中的位置覆盖当前共享位置，默认 false"),
      },
      (args, context) =>
        ok(importAssistantExport(context ?? requireProfileContext(), args.data, {
          applyLocation: args.applyLocation ?? false,
        })),
    ),
  ],
};

registerModule(assistantModule);
