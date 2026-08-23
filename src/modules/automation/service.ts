import crypto from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import { config } from "../../config.js";
import { getDatabase } from "../../core/database.js";
import { publishNotification } from "../../core/notification-publisher.js";
import { requireProfileContext, type ProfileContext } from "../../core/profile.js";
import { automationActions } from "./actions.js";
import { automationResultNotification, resultFields } from "./notification.js";
import type { AutomationCondition, AutomationItem, AutomationListOptions } from "./types.js";

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const automationScheduleSchema = z.union([
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(TIME_OF_DAY, "time 必须是 HH:mm"),
    timezone: z.string().optional().describe("IANA 时区，缺省用 LIFE_ASSISTANT_TIMEZONE"),
  }),
  z.object({
    type: z.literal("interval"),
    minutes: z.number().int().min(5).max(10080).describe("间隔分钟数（5 分钟–7 天）"),
  }),
]);

export const automationConditionSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum([">", ">=", "<", "<=", "==", "!="]),
  value: z.union([z.number(), z.string()]),
});

export interface AutomationCreateInput {
  /** 导入场景保留原 ID；常规创建忽略 */
  id?: string;
  name: string;
  action: string;
  params?: Record<string, unknown>;
  condition?: AutomationCondition;
  schedule: z.infer<typeof automationScheduleSchema>;
  enabled?: boolean;
}

function context(value: ProfileContext | string): ProfileContext {
  return typeof value === "string" ? requireProfileContext(value) : requireProfileContext(value.id);
}

function normalizeSchedule(schedule: z.infer<typeof automationScheduleSchema>): AutomationItem["schedule"] {
  if (schedule.type === "interval") return schedule;
  const timezone = schedule.timezone?.trim() || config.timezone;
  if (!DateTime.now().setZone(timezone).isValid) throw new Error(`无效时区：${timezone}`);
  return { type: "daily", time: schedule.time, timezone };
}

function validateAction(action: string, params: Record<string, unknown> | undefined): { action: string; params: Record<string, unknown> } {
  const def = automationActions[action];
  if (!def) {
    throw new Error(`未知 action：${action}。可用 action：${Object.keys(automationActions).join(" / ")}`);
  }
  return { action, params: def.paramsSchema.parse(params ?? {}) };
}

function rowToItem(row: Record<string, unknown>): AutomationItem {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    name: String(row.name),
    action: String(row.action),
    params: JSON.parse(String(row.params_json ?? "{}")) as Record<string, unknown>,
    condition: row.condition_json == null ? undefined : JSON.parse(String(row.condition_json)) as AutomationCondition,
    schedule: JSON.parse(String(row.schedule_json)) as AutomationItem["schedule"],
    enabled: Number(row.enabled) === 1,
    lastRunAt: row.last_run_at == null ? undefined : String(row.last_run_at),
    lastResult: row.last_result == null ? undefined : String(row.last_result),
    lastError: row.last_error == null ? undefined : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createAutomation(value: ProfileContext | string, input: AutomationCreateInput): AutomationItem {
  const profile = context(value);
  const name = z.string().min(1).max(100).parse(input.name);
  const { action, params } = validateAction(
    z.string().min(1).max(64).parse(input.action),
    input.params,
  );
  const condition = input.condition === undefined ? undefined : automationConditionSchema.parse(input.condition);
  const schedule = normalizeSchedule(automationScheduleSchema.parse(input.schedule));
  const enabled = input.enabled ?? true;

  const db = getDatabase();
  const time = new Date().toISOString();
  // 导入场景保留原 ID；非法/缺省回退 UUID。
  const importedId = typeof input.id === "string" ? input.id.trim() : "";
  if (importedId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(importedId)) {
    throw new Error(`invalid automation id: ${importedId}`);
  }
  const id = importedId || crypto.randomUUID();
  db.prepare(`
    INSERT INTO automations(
      profile_id, id, name, action, params_json, condition_json, schedule_json,
      enabled, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    profile.id,
    id,
    name,
    action,
    JSON.stringify(params),
    condition === undefined ? null : JSON.stringify(condition),
    JSON.stringify(schedule),
    enabled ? 1 : 0,
    time,
    time,
  );
  return getAutomation(profile, id);
}

export function listAutomations(value: ProfileContext | string, options: AutomationListOptions = {}): AutomationItem[] {
  const profile = context(value);
  const clauses = ["profile_id = ?"];
  const params: unknown[] = [profile.id];
  if (options.enabled !== undefined) {
    clauses.push("enabled = ?");
    params.push(options.enabled ? 1 : 0);
  }
  const rows = getDatabase().prepare(
    `SELECT * FROM automations WHERE ${clauses.join(" AND ")} ORDER BY created_at, rowid`,
  ).all(...params as any[]) as Array<Record<string, unknown>>;
  return rows.map(rowToItem);
}

export function getAutomation(value: ProfileContext | string, id: string): AutomationItem {
  const profile = context(value);
  const row = getDatabase().prepare(
    "SELECT * FROM automations WHERE profile_id = ? AND id = ?",
  ).get(profile.id, id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`automation ${id} 不存在或不属于当前 Profile`);
  return rowToItem(row);
}

export interface AutomationUpdateInput {
  name?: string;
  action?: string;
  params?: Record<string, unknown>;
  /** 传 null 表示清除条件 */
  condition?: AutomationCondition | null;
  schedule?: z.infer<typeof automationScheduleSchema>;
  enabled?: boolean;
}

export function updateAutomation(value: ProfileContext | string, id: string, changes: AutomationUpdateInput): AutomationItem {
  const profile = context(value);
  const current = getAutomation(profile, id);
  const name = changes.name === undefined ? current.name : z.string().min(1).max(100).parse(changes.name);
  const nextAction = changes.action === undefined && changes.params === undefined
    ? { action: current.action, params: current.params }
    : validateAction(changes.action ?? current.action, changes.params ?? current.params);
  const condition = changes.condition === undefined
    ? current.condition
    : changes.condition === null
      ? undefined
      : automationConditionSchema.parse(changes.condition);
  const schedule = changes.schedule === undefined
    ? current.schedule
    : normalizeSchedule(automationScheduleSchema.parse(changes.schedule));
  const enabled = changes.enabled === undefined ? current.enabled : changes.enabled;

  getDatabase().prepare(`
    UPDATE automations
    SET name = ?, action = ?, params_json = ?, condition_json = ?, schedule_json = ?,
        enabled = ?, last_error = NULL, updated_at = ?
    WHERE profile_id = ? AND id = ?
  `).run(
    name,
    nextAction.action,
    JSON.stringify(nextAction.params),
    condition === undefined ? null : JSON.stringify(condition),
    JSON.stringify(schedule),
    enabled ? 1 : 0,
    new Date().toISOString(),
    profile.id,
    id,
  );
  return getAutomation(profile, id);
}

export function deleteAutomation(value: ProfileContext | string, id: string): void {
  const profile = context(value);
  const result = getDatabase().prepare(
    "DELETE FROM automations WHERE profile_id = ? AND id = ?",
  ).run(profile.id, id) as { changes: number };
  if (result.changes === 0) throw new Error(`automation ${id} 不存在或不属于当前 Profile`);
}

// ---------------------------------------------------------------------------
// 到期判断与条件求值（纯函数）
// ---------------------------------------------------------------------------

export function isAutomationDue(item: AutomationItem, at: Date): boolean {
  if (!item.enabled) return false;
  if (item.schedule.type === "interval") {
    if (!item.lastRunAt) return true;
    const last = Date.parse(item.lastRunAt);
    if (!Number.isFinite(last)) return true;
    return at.getTime() - last >= item.schedule.minutes * 60_000;
  }
  const nowLocal = DateTime.fromJSDate(at).setZone(item.schedule.timezone);
  if (!nowLocal.isValid) return false;
  const [hour, minute] = item.schedule.time.split(":").map(Number);
  const target = nowLocal.startOf("day").plus({ hours: hour, minutes: minute });
  if (item.lastRunAt) {
    const lastLocal = DateTime.fromISO(item.lastRunAt, { setZone: true }).setZone(item.schedule.timezone);
    if (lastLocal.isValid && lastLocal.hasSame(nowLocal, "day")) return false;
  }
  return nowLocal >= target;
}

function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc === undefined || acc === null) return undefined;
    if (Array.isArray(acc)) {
      const index = Number(segment);
      return Number.isInteger(index) && index >= 0 ? acc[index] : undefined;
    }
    if (typeof acc === "object") return (acc as Record<string, unknown>)[segment];
    return undefined;
  }, source);
}

/** 条件求值：数值按数值比较，否则按字符串比较；字段缺失/不可比较一律不满足。 */
export function evaluateCondition(condition: AutomationCondition, result: Record<string, unknown>): boolean {
  const actual = getPath(result, condition.field);
  if (actual === undefined || actual === null) return false;
  if (typeof condition.value === "number") {
    const numeric = typeof actual === "number" ? actual : Number(actual);
    if (!Number.isFinite(numeric)) return false;
    switch (condition.op) {
      case ">": return numeric > condition.value;
      case ">=": return numeric >= condition.value;
      case "<": return numeric < condition.value;
      case "<=": return numeric <= condition.value;
      case "==": return numeric === condition.value;
      case "!=": return numeric !== condition.value;
    }
  }
  const text = String(actual);
  const expected = String(condition.value);
  switch (condition.op) {
    case ">": return text > expected;
    case ">=": return text >= expected;
    case "<": return text < expected;
    case "<=": return text <= expected;
    case "==": return text === expected;
    case "!=": return text !== expected;
  }
}

function itemTimezone(item: AutomationItem): string {
  return item.schedule.type === "daily" ? item.schedule.timezone : config.timezone;
}

// ---------------------------------------------------------------------------
// 扫描与手动执行
// ---------------------------------------------------------------------------

type ProfilePublisher = (
  profileId: string,
  source: string,
  title: string,
  body: string,
  dedupeKey: string,
  legacyDedupeKeys?: readonly string[],
) => Promise<void>;

export interface AutomationRunOutcome {
  id: string;
  profileId: string;
  ran: boolean;
  published: boolean;
  error?: string;
}

export interface AutomationScanOptions {
  at?: Date;
  /** 测试注入：覆盖 action 执行表 */
  actions?: Record<string, { run: (params: Record<string, unknown>) => Promise<Record<string, unknown>> }>;
  /** 测试注入：覆盖 Profile 发布通道 */
  publishProfile?: ProfilePublisher;
}

async function executeAutomation(
  item: AutomationItem,
  options: AutomationRunOptions,
): Promise<AutomationRunOutcome> {
  const at = options.at ?? new Date();
  const actions = options.actions ?? automationActions;
  const def = actions[item.action];
  if (!def) throw new Error(`未知 action：${item.action}`);
  const result = await def.run(item.params);
  const conditionMet = item.condition ? evaluateCondition(item.condition, result) : true;
  const timezone = itemTimezone(item);
  const localDate = DateTime.fromJSDate(at).setZone(timezone).toISODate() ?? at.toISOString().slice(0, 10);
  if (conditionMet) {
    const notification = automationResultNotification({
      item,
      fields: resultFields(result),
      identity: `${item.id}:${localDate}`,
      generatedAt: at.toISOString(),
      timezone,
    });
    await publishNotification(notification, options.publishProfile ? { publishProfile: options.publishProfile } : {});
  }
  return { id: item.id, profileId: item.profileId, ran: true, published: conditionMet };
}

export interface AutomationRunOptions extends AutomationScanOptions {}

function recordRun(profileId: string, id: string, at: Date, patch: { lastResult?: string; lastError?: string | null }): void {
  getDatabase().prepare(`
    UPDATE automations
    SET last_run_at = ?, last_result = COALESCE(?, last_result), last_error = ?, updated_at = ?
    WHERE profile_id = ? AND id = ?
  `).run(
    at.toISOString(),
    patch.lastResult ?? null,
    patch.lastError ?? null,
    at.toISOString(),
    profileId,
    id,
  );
}

/** scheduler 扫描：执行所有到期且启用的 automation；单条失败不阻断其余。 */
export async function runAutomationScan(options: AutomationScanOptions = {}): Promise<AutomationRunOutcome[]> {
  const at = options.at ?? new Date();
  const db = getDatabase();
  // 排序 tie-break 用 rowid（插入顺序）而不是随机 UUID id：同一毫秒创建的
  // 多行 created_at 相同，按 id 排序结果不确定（曾导致 scan 用例 ~45% 概率失败）。
  const rows = db.prepare("SELECT * FROM automations WHERE enabled = 1 ORDER BY created_at, rowid")
    .all() as Array<Record<string, unknown>>;
  const outcomes: AutomationRunOutcome[] = [];
  for (const row of rows) {
    // hydration/到期判定同样在 per-item 容错内：一行损坏的 automations 数据
    // （如截断的 JSON 列）不得让整个扫描循环抛出、停掉所有 Profile 的任务。
    try {
      const item = rowToItem(row);
      if (!isAutomationDue(item, at)) continue;
      const outcome = await executeAutomation(item, options);
      outcomes.push(outcome);
      recordRun(item.profileId, item.id, at, {
        lastResult: JSON.stringify({ at: at.toISOString(), published: outcome.published }),
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const identity = rowToItemId(row);
      console.error(`[automation] ${String(row.profile_id)}/${identity} failed: ${message}`);
      // 到期即记 last_run_at，避免失败任务每个扫描周期重试放大故障。
      recordRun(String(row.profile_id), identity, at, { lastError: message });
      outcomes.push({ id: identity, profileId: String(row.profile_id), ran: false, published: false, error: message });
    }
  }
  return outcomes;
}

/** 损坏行的降级标识：rowToItem 抛错时仍要在结果里定位到具体条目。 */
function rowToItemId(row: Record<string, unknown>): string {
  return typeof row.id === "string" && row.id.length > 0 ? row.id : "unknown-id";
}

/** 手动执行一次（用于配置验证）：不推进 last_run_at，不影响既定调度节奏。 */
export async function runAutomationNow(
  value: ProfileContext | string,
  id: string,
  options: AutomationRunOptions = {},
): Promise<AutomationRunOutcome & { result?: Record<string, unknown> }> {
  const profile = context(value);
  const item = getAutomation(profile, id);
  const at = options.at ?? new Date();
  const actions = options.actions ?? automationActions;
  const def = actions[item.action];
  if (!def) throw new Error(`未知 action：${item.action}`);
  const result = await def.run(item.params);
  const conditionMet = item.condition ? evaluateCondition(item.condition, result) : true;
  const timezone = itemTimezone(item);
  const minuteBucket = DateTime.fromJSDate(at).setZone(timezone).toFormat("yyyy-LL-dd'T'HH:mm");
  if (conditionMet) {
    const notification = automationResultNotification({
      item,
      fields: resultFields(result),
      identity: `${item.id}:run:${minuteBucket}`,
      generatedAt: at.toISOString(),
      timezone,
    });
    await publishNotification(notification, options.publishProfile ? { publishProfile: options.publishProfile } : {});
  }
  return {
    id: item.id,
    profileId: item.profileId,
    ran: true,
    published: conditionMet,
    result,
  };
}
