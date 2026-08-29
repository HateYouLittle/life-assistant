import crypto from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import { config } from "../../config.js";
import { getDatabase } from "../../core/database.js";
import { publishNotification } from "../../core/notification-publisher.js";
import type { ProfilePublishFn } from "../../core/notifier.js";
import { asProfileContext, isWellFormedId, requireProfileContext, type ProfileContext } from "../../core/profile.js";
import { automationActions, actionConditionFields, isConditionFieldAllowed } from "./actions.js";
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

/**
 * L36：条件校验 = schema 解析 + 结果字段白名单 + 字符串值只允许 ==/!=。
 * - field 必须是该 action 结果字段白名单内的 dot-path（数组下标用数字段）；
 * - value 为字符串时，字典序比较（"9" > "10" 为 true）语义不可控，创建/更新时拒绝
 *   >、>=、<、<=，只保留 == / !=（数值比较请用数字值）。
 */
export function validateCondition(
  action: string,
  condition: AutomationCondition | undefined,
): AutomationCondition | undefined {
  if (condition === undefined) return undefined;
  const parsed = automationConditionSchema.parse(condition);
  if (!isConditionFieldAllowed(action, parsed.field)) {
    throw new Error(
      `condition field "${parsed.field}" 不在 action ${action} 的结果字段白名单内` +
        `（可用字段：${(actionConditionFields[action] ?? []).join(" / ")}）`,
    );
  }
  if (typeof parsed.value === "string" && parsed.op !== "==" && parsed.op !== "!=") {
    throw new Error(`字符串比较仅支持 == / !=（field "${parsed.field}" op "${parsed.op}"）；请改用数字值做大小比较`);
  }
  return parsed;
}

/**
 * 换 action 时对「沿用旧条件」的复检：旧条件是对旧 action 校验的，其 field 可能不在
 * 新 action 的结果白名单内——届时 getPath 恒取不到值，条件永不满足，任务到点静默
 * 不提醒。这里明确报错而不是静默失效（与强提醒缺失 occurrence 正式提醒同口径），
 * 提示用户同步更新 condition 或传 null 清除。
 */
function revalidateRetainedCondition(
  action: string,
  condition: AutomationCondition | undefined,
): AutomationCondition | undefined {
  try {
    return validateCondition(action, condition);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}；更换 action 时请同步更新 condition，或传 null 清除`);
  }
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

function rowToItemReadable(row: Record<string, unknown>): AutomationItem {
  try { return rowToItem(row); } catch (error) {
    return {
      id: String(row.id), profileId: String(row.profile_id), name: String(row.name ?? "(损坏)"),
      action: String(row.action ?? ""), params: {}, enabled: false,
      lastError: `automation data corrupted: ${error instanceof Error ? error.message : String(error)}`,
      createdAt: String(row.created_at ?? ""), updatedAt: String(row.updated_at ?? ""),
      schedule: { type: "interval", minutes: 60 },
    };
  }
}

export function createAutomation(value: ProfileContext | string, input: AutomationCreateInput): AutomationItem {
  const profile = asProfileContext(value);
  const name = z.string().min(1).max(100).parse(input.name);
  const { action, params } = validateAction(
    z.string().min(1).max(64).parse(input.action),
    input.params,
  );
  const condition = validateCondition(action, input.condition);
  const schedule = normalizeSchedule(automationScheduleSchema.parse(input.schedule));
  const enabled = input.enabled ?? true;

  const db = getDatabase();
  const time = new Date().toISOString();
  // 导入场景保留原 ID；非法/缺省回退 UUID。
  const importedId = typeof input.id === "string" ? input.id.trim() : "";
  if (importedId && !isWellFormedId(importedId)) {
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
  const profile = asProfileContext(value);
  const clauses = ["profile_id = ?"];
  const params: unknown[] = [profile.id];
  if (options.enabled !== undefined) {
    clauses.push("enabled = ?");
    params.push(options.enabled ? 1 : 0);
  }
  const rows = getDatabase().prepare(
    `SELECT * FROM automations WHERE ${clauses.join(" AND ")} ORDER BY created_at, rowid`,
  ).all(...params as any[]) as Array<Record<string, unknown>>;
  return rows.map(rowToItemReadable);
}

export function getAutomation(value: ProfileContext | string, id: string): AutomationItem {
  const profile = asProfileContext(value);
  const row = getDatabase().prepare(
    "SELECT * FROM automations WHERE profile_id = ? AND id = ?",
  ).get(profile.id, id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`automation ${id} 不存在或不属于当前 Profile`);
  return rowToItemReadable(row);
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
  const profile = asProfileContext(value);
  const current = getAutomation(profile, id);
  const name = changes.name === undefined ? current.name : z.string().min(1).max(100).parse(changes.name);
  const nextAction = changes.action === undefined && changes.params === undefined
    ? { action: current.action, params: current.params }
    : validateAction(changes.action ?? current.action, changes.params ?? current.params);
  const condition = changes.condition === undefined
    ? (nextAction.action === current.action
        ? current.condition
        : revalidateRetainedCondition(nextAction.action, current.condition))
    : changes.condition === null
      ? undefined
      : validateCondition(nextAction.action, changes.condition);
  const schedule = changes.schedule === undefined
    ? current.schedule
    : normalizeSchedule(automationScheduleSchema.parse(changes.schedule));
  const enabled = changes.enabled === undefined ? current.enabled : changes.enabled;
  const configChanged = changes.name !== undefined || changes.action !== undefined || changes.params !== undefined
    || changes.condition !== undefined || changes.schedule !== undefined || changes.enabled !== undefined;

  getDatabase().prepare(`
    UPDATE automations
    SET name = ?, action = ?, params_json = ?, condition_json = ?, schedule_json = ?,
        enabled = ?, last_run_at = CASE WHEN ? THEN NULL ELSE last_run_at END,
        last_result = CASE WHEN ? THEN NULL ELSE last_result END,
        last_error = NULL, updated_at = ?
    WHERE profile_id = ? AND id = ?
  `).run(
    name,
    nextAction.action,
    JSON.stringify(nextAction.params),
    condition === undefined ? null : JSON.stringify(condition),
    JSON.stringify(schedule),
    enabled ? 1 : 0,
    configChanged ? 1 : 0,
    configChanged ? 1 : 0,
    new Date().toISOString(),
    profile.id,
    id,
  );
  return getAutomation(profile, id);
}

export function deleteAutomation(value: ProfileContext | string, id: string): void {
  const profile = asProfileContext(value);
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
    if (typeof acc === "object") {
      // L36：只取自有属性，且显式拒绝原型链探针段：__proto__/constructor/prototype
      // 命中即视为字段缺失（条件不满足），杜绝用条件 DSL 探测对象原型链。
      if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return undefined;
      const record = acc as Record<string, unknown>;
      return Object.prototype.hasOwnProperty.call(record, segment) ? record[segment] : undefined;
    }
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
  publishProfile?: ProfilePublishFn;
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

/**
 * 失败路径落库（L34/L35）：
 * - L35：last_result 显式置 NULL——否则 COALESCE 保留旧的「成功结果」，list 展示出现
 *   「旧成功结果 + 新错误」并存，lastResult/lastError 语义互斥；
 * - L34：last_run_at 仅在 interval 语义下推进（避免每个扫描周期重试放大故障）；
 *   daily 失败不推进——isAutomationDue 的 daily 分支按 lastRunAt 同本地日去重，
 *   一旦推进会让「一次失败即丢一整天」，与 interval 行为不对称。
 */
function recordRunFailure(
  profileId: string,
  id: string,
  at: Date,
  scheduleType: "daily" | "interval",
  message: string,
): void {
  const advanceLastRun = scheduleType === "interval";
  const sql = advanceLastRun
    ? "UPDATE automations SET last_run_at = ?, last_result = NULL, last_error = ?, updated_at = ? WHERE profile_id = ? AND id = ?"
    : "UPDATE automations SET last_result = NULL, last_error = ?, updated_at = ? WHERE profile_id = ? AND id = ?";
  const params: unknown[] = advanceLastRun
    ? [at.toISOString(), message, at.toISOString(), profileId, id]
    : [message, at.toISOString(), profileId, id];
  getDatabase().prepare(sql).run(...params as any[]);
}

/** 损坏行无法完整 hydration 时，尽力判读 schedule 类型以决定失败路径是否推进 last_run_at。 */
function readScheduleType(row: Record<string, unknown>): "daily" | "interval" {
  try {
    const parsed = JSON.parse(String(row.schedule_json ?? "{}")) as { type?: unknown };
    return parsed.type === "daily" ? "daily" : "interval";
  } catch {
    return "interval";
  }
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
      // L34/L35：失败路径 daily 不推进 last_run_at（当日保留可重试），
      // interval 推进（避免每个扫描周期重试放大故障）；last_result 置 NULL 保互斥。
      recordRunFailure(String(row.profile_id), identity, at, readScheduleType(row), message);
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
  const profile = asProfileContext(value);
  const item = getAutomation(profile, id);
  const at = options.at ?? new Date();
  const actions = options.actions ?? automationActions;
  const def = actions[item.action];
  if (!def) throw new Error(`未知 action：${item.action}`);
  const result = await def.run(item.params);
  const conditionMet = item.condition ? evaluateCondition(item.condition, result) : true;
  const timezone = itemTimezone(item);
  // L37：复用手动执行目标的当日 identity（与 scan 的 `${id}:${localDate}` 同源），
  // 「同一本地日期最多提醒一次」语义一致；旧 :run: 分钟桶会让同一分钟 scan 与
  // run 命中同一任务时双键双发，且跨分钟重复手动执行也不去重。
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
  return {
    id: item.id,
    profileId: item.profileId,
    ran: true,
    published: conditionMet,
    result,
  };
}
