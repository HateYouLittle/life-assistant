import { z } from "zod";
import { registerModule, ok, fail, type AssistantModule } from "../../core/registry.js";
import { requireProfileContext, type ProfileContext } from "../../core/profile.js";
import { getDatabase } from "../../core/database.js";
import { currentLocation, saveImportedLocation } from "../../core/location.js";
import { getQuietHours, saveQuietHours } from "../../core/notification-settings.js";
import {
  createSchedule,
  getSchedule,
  hydrateRow,
  updateSchedule,
} from "../schedule/service.js";
import type { ScheduleItem } from "../schedule/types.js";
import { createAutomation, getAutomation, type AutomationCreateInput } from "../automation/service.js";
import { automationScheduleSchema } from "../automation/service.js";

export const EXPORT_FORMAT = "life-assistant.export";
export const EXPORT_VERSION = 1;
/** 单类条目导出上限；超出时快照带 truncated 标记，导入方应提示用户分批处理。 */
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
    /** 任一类条目达到导出上限时为 true：快照不完整，导入方应提示 */
    truncated?: boolean;
  };
}

export function buildAssistantExport(profile: ProfileContext): AssistantExport {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT * FROM schedules WHERE profile_id = ? ORDER BY created_at, id LIMIT ?",
  ).all(profile.id, EXPORT_ROW_LIMIT) as Array<Record<string, unknown>>;
  const automations = db.prepare(
    "SELECT * FROM automations WHERE profile_id = ? ORDER BY created_at, id LIMIT ?",
  ).all(profile.id, EXPORT_ROW_LIMIT) as Array<Record<string, unknown>>;
  const quiet = getQuietHours(profile.id);
  const loc = currentLocation();
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    profile: profile.id,
    data: {
      schedules: rows.map((row) => toPortableSchedule(hydrateRow(row))),
      automations: automations.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        action: String(row.action),
        params: JSON.parse(String(row.params_json ?? "{}")) as Record<string, unknown>,
        condition: row.condition_json == null
          ? undefined
          : JSON.parse(String(row.condition_json)) as AutomationCreateInput["condition"],
        schedule: JSON.parse(String(row.schedule_json)) as AutomationCreateInput["schedule"],
        enabled: Number(row.enabled) === 1,
      })),
      quietHours: quiet ? { start: quiet.start, end: quiet.end, timezone: quiet.timezone } : null,
      location: loc ? { city: loc.city, province: loc.province, lat: loc.lat, lon: loc.lon } : null,
      truncated: rows.length >= EXPORT_ROW_LIMIT || automations.length >= EXPORT_ROW_LIMIT,
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

const exportPayloadSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
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
  // 前置版本检查给出可读错误；schema 的 z.literal 再做一层防御。
  if (head.version !== EXPORT_VERSION) {
    throw new Error(`不支持的快照版本 ${String(head.version)}（当前支持版本 ${EXPORT_VERSION}）`);
  }
  const parsed = exportPayloadSchema.parse(payload);
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
      const { id, status, recurrence, ...rest } = entry;
      const created = createSchedule(profile, {
        ...rest,
        id,
        recurrence: recurrence as PortableSchedule["recurrence"],
      });
      if (status && status !== created.status) {
        updateSchedule(profile, id, { status });
      }
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
    {
      name: "export",
      description: "导出当前 Profile 的数据快照（日程全量含状态、自动任务、静默时段和共享位置）为 JSON，用于备份或迁移。返回的 JSON 可原样传给 assistant.import。导出不包含通知历史与 Webhook secret。单类条目超过 1000 条时 truncated=true，快照不完整，应提示用户。",
      schema: {},
      handler: async (_args, context) => {
        try {
          return ok(buildAssistantExport(context ?? requireProfileContext()));
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    },
    {
      name: "import",
      description: "导入 assistant.export 生成的快照（仅支持当前导出版本）：日程/自动任务按 ID 幂等导入（已存在的跳过，不覆盖），静默时段直接应用；applyLocation=true 时才覆盖共享位置（多 Profile 共享位置，默认不动）。非法条目跳过并计入 invalid；快照带 truncated=true 时应向用户说明数据不完整。",
      schema: {
        data: z.unknown().describe("assistant.export 返回的快照对象"),
        applyLocation: z.boolean().optional().describe("是否用快照中的位置覆盖当前共享位置，默认 false"),
      },
      handler: async (args, context) => {
        try {
          const parsed = z.object({
            data: z.unknown(),
            applyLocation: z.boolean().optional(),
          }).parse(args ?? {});
          return ok(importAssistantExport(context ?? requireProfileContext(), parsed.data, {
            applyLocation: parsed.applyLocation ?? false,
          }));
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    },
  ],
};

registerModule(assistantModule);
