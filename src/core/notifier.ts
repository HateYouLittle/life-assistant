import crypto from "node:crypto";
import { config } from "../config.js";
import { getDatabase } from "./database.js";
import { quietProfileIds } from "./notification-settings.js";
import { requireProfileContext, type ProfileContext } from "./profile.js";

export interface Notice {
  id: number;
  scope: "global" | "profile";
  profileId?: string;
  source: string;
  title: string;
  body: string;
  time: string;
  dedupeKey?: string;
}

export interface DeliverySummary {
  attempted: number;
  sent: number;
  failed: number;
}

const MAX_CONFIRMED_HTTP_ATTEMPTS = 5;
/** route 配置漂移导致的 fallback 标记（route 恢复后可重新入队）。 */
const ROUTE_CHANGED_ERROR = "configured webhook route changed";
const ROUTE_MISSING_ERROR = "configured webhook route is missing or changed";

function now(): string {
  return new Date().toISOString();
}

function asContext(value: ProfileContext | string): ProfileContext {
  return typeof value === "string" ? requireProfileContext(value) : requireProfileContext(value.id);
}

function noticeFromRow(row: Record<string, unknown>, scope: "global" | "profile"): Notice {
  return {
    id: Number(row.id),
    scope,
    profileId: scope === "profile" ? String(row.profile_id) : undefined,
    source: String(row.source),
    title: String(row.title),
    body: String(row.body),
    time: String(row.created_at),
    dedupeKey: row.dedupe_key == null ? undefined : String(row.dedupe_key),
  };
}

function findLegacyDedupeId(
  table: "global_notifications" | "profile_notifications",
  legacyDedupeKeys: readonly string[],
  profileId?: string,
): number | undefined {
  const db = getDatabase();
  for (const legacyDedupeKey of legacyDedupeKeys) {
    let row: Record<string, unknown> | undefined;
    if (table === "global_notifications") {
      row = db.prepare(
        "SELECT id FROM global_notifications WHERE dedupe_key = ?",
      ).get(legacyDedupeKey);
    } else {
      if (profileId === undefined) throw new Error("profile ID is required for a Profile dedupe lookup");
      row = db.prepare(
        "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
      ).get(profileId, legacyDedupeKey);
    }
    if (row) return Number((row as { id: number }).id);
  }
  return undefined;
}

function suppressRetainedGlobal(dedupeKey: string, legacyDedupeKeys: readonly string[]): boolean {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare(
      "SELECT id FROM global_notifications WHERE dedupe_key = ?",
    ).get(dedupeKey);
    const legacyId = current ? undefined : findLegacyDedupeId("global_notifications", legacyDedupeKeys);
    if (legacyId !== undefined) {
      db.prepare("UPDATE global_notifications SET dedupe_key = ? WHERE id = ?").run(dedupeKey, legacyId);
    }
    db.exec("COMMIT");
    return Boolean(current) || legacyId !== undefined;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Publish one shared event. Supports (source, title, body, key) and (title, body, key). */
export async function publishGlobal(
  sourceOrTitle: string,
  titleOrBody: string,
  bodyOrKey?: string,
  maybeDedupeKey?: string,
  legacyDedupeKeys: readonly string[] = [],
  options: {
    renderForProfile?: (profileId: string, shared: { title: string; body: string }) => { title: string; body: string };
  } = {},
): Promise<void> {
  const hasSource = maybeDedupeKey !== undefined;
  const source = hasSource ? sourceOrTitle : "general";
  const title = hasSource ? titleOrBody : sourceOrTitle;
  const body = hasSource ? bodyOrKey ?? "" : titleOrBody;
  const dedupeKey = hasSource ? maybeDedupeKey : bodyOrKey;
  if (dedupeKey !== undefined && suppressRetainedGlobal(dedupeKey, legacyDedupeKeys)) return;
  for (const profileId of Object.keys(config.profilePushRoutes)) {
    // 每 Profile 渲染回调只替换落库快照；suppressRetainedGlobal / legacy dedupe /
    // delivery 创建逻辑一律不变（R5）。
    const rendered = options.renderForProfile
      ? options.renderForProfile(profileId, { title, body })
      : { title, body };
    await publishResolvedProfile(profileId, source, rendered.title, rendered.body, dedupeKey, legacyDedupeKeys);
  }
}

/** Publish an event that can only be consumed by one Profile. */
export async function publishProfile(
  profileId: string,
  sourceOrTitle: string,
  titleOrBody: string,
  bodyOrKey?: string,
  maybeDedupeKey?: string,
  legacyDedupeKeys: readonly string[] = [],
): Promise<void> {
  const hasSource = maybeDedupeKey !== undefined;
  const source = hasSource ? sourceOrTitle : "schedule";
  const title = hasSource ? titleOrBody : sourceOrTitle;
  const body = hasSource ? bodyOrKey ?? "" : titleOrBody;
  const dedupeKey = hasSource ? maybeDedupeKey : bodyOrKey;
  await publishResolvedProfile(profileId, source, title, body, dedupeKey, legacyDedupeKeys);
}

async function publishResolvedProfile(
  profileId: string,
  source: string,
  title: string,
  body: string,
  dedupeKey?: string,
  legacyDedupeKeys: readonly string[] = [],
): Promise<void> {
  const profile = requireProfileContext(profileId);
  const db = getDatabase();
  const time = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR IGNORE INTO profiles(profile_id, created_at) VALUES(?, ?)").run(profile.id, time);
    const current = dedupeKey === undefined
      ? undefined
      : db.prepare(
          "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
        ).get(profile.id, dedupeKey) as { id: number } | undefined;
    const legacyId = (current || dedupeKey === undefined)
      ? undefined
      : findLegacyDedupeId("profile_notifications", legacyDedupeKeys, profile.id);
    if (legacyId !== undefined) {
      if (dedupeKey === undefined) throw new Error("dedupe key is required for legacy key promotion");
      db.prepare(
        "UPDATE profile_notifications SET dedupe_key = ? WHERE profile_id = ? AND id = ?",
      ).run(dedupeKey, profile.id, legacyId);
    }
    let notificationId = current?.id ?? legacyId;
    if (notificationId === undefined) {
      const inserted = db.prepare(
        "INSERT OR IGNORE INTO profile_notifications(profile_id, source, title, body, created_at, dedupe_key) VALUES(?, ?, ?, ?, ?, ?)",
      ).run(profile.id, source, title, body, time, dedupeKey ?? null) as {
        changes: number;
        lastInsertRowid: number | bigint;
      };
      notificationId = inserted.changes
        ? Number(inserted.lastInsertRowid)
        : Number((db.prepare(
            "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
          ).get(profile.id, dedupeKey ?? null) as { id?: number } | undefined)?.id ?? 0);
    }
    const route = Object.prototype.hasOwnProperty.call(config.profilePushRoutes, profile.id)
      ? config.profilePushRoutes[profile.id]
      : undefined;
    const alreadyHandled = notificationId
      ? db.prepare(`
          SELECT 1 FROM profile_notification_deliveries
          WHERE profile_id = ? AND notification_id = ? AND status IN ('sent', 'sending')
          UNION ALL
          SELECT 1 FROM profile_notification_reads
          WHERE profile_id = ? AND notification_id = ?
          LIMIT 1
        `).get(profile.id, notificationId, profile.id, notificationId)
      : undefined;
    if (notificationId && route && !alreadyHandled) {
      db.prepare(`
        UPDATE profile_notification_deliveries
        SET status = 'fallback', claim_token = NULL, claimed_at = NULL,
            last_error = ?, updated_at = ?
        WHERE profile_id = ? AND notification_id = ? AND route <> ?
          AND status IN ('pending', 'failed', 'fallback')
      `).run(ROUTE_CHANGED_ERROR, time, profile.id, notificationId, route.route);
      db.prepare(`
        INSERT OR IGNORE INTO profile_notification_deliveries(
          profile_id, notification_id, route, status, attempts,
          next_attempt_at, created_at, updated_at
        ) VALUES(?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(profile.id, notificationId, route.route, time, time, time);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // All active delivery is handled by the Profile outbox.
}

export async function deliverPendingProfileNotifications(options: {
  at?: Date;
  profileId?: string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
} = {}): Promise<DeliverySummary> {
  const at = options.at ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const db = getDatabase();
  const dueAt = at.toISOString();
  const staleClaimAt = new Date(at.getTime() - 2 * 60 * 1000).toISOString();
  const expiredClaimAt = new Date(at.getTime() - 55 * 60 * 1000).toISOString();
  const profileIdFilter = options.profileId ? requireProfileContext(options.profileId).id : undefined;

  // 静默时段内的 Profile 本轮完全不尝试主动投递；行保持 pending，窗口结束后由下一 tick 恢复。
  // notify.pull 不受静默时段限制（用户主动拉取）。
  const quiet = quietProfileIds(at);
  if (profileIdFilter && quiet.has(profileIdFilter)) {
    return { attempted: 0, sent: 0, failed: 0 };
  }
  const quietIds = [...quiet];
  const quietClause = quietIds.length > 0
    ? `AND profile_id NOT IN (${quietIds.map(() => "?").join(",")})`
    : "";
  const quietClauseAliased = quietIds.length > 0
    ? `AND d.profile_id NOT IN (${quietIds.map(() => "?").join(",")})`
    : "";

  // 幂等窗口 fallback 必须先于 route-drift 标记执行：超过 55 分钟的
  // transport-failed/sending 行直接进入终态 fallback，避免被 ROUTE_MISSING
  // 抢占后在 route 恢复时以新 Request-ID 重复投递。
  if (profileIdFilter) {
    db.prepare(`
      UPDATE profile_notification_deliveries
      SET request_started_at = COALESCE(request_started_at, claimed_at, updated_at)
      WHERE profile_id = ? AND status = 'sending' AND request_started_at IS NULL
    `).run(profileIdFilter);
    db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'fallback', claim_token = NULL, claimed_at = NULL,
          last_error = 'uncertain delivery exceeded webhook idempotency window', updated_at = ?
      WHERE profile_id = ? AND status IN ('sending', 'failed') AND request_started_at <= ?
    `).run(dueAt, profileIdFilter, expiredClaimAt);
  } else {
    db.prepare(`
      UPDATE profile_notification_deliveries
      SET request_started_at = COALESCE(request_started_at, claimed_at, updated_at)
      WHERE status = 'sending' AND request_started_at IS NULL
    `).run();
    db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'fallback', claim_token = NULL, claimed_at = NULL,
          last_error = 'uncertain delivery exceeded webhook idempotency window', updated_at = ?
      WHERE status IN ('sending', 'failed') AND request_started_at <= ?
    `).run(dueAt, expiredClaimAt);
  }

  const routeCandidates = (profileIdFilter
    ? db.prepare(`
        SELECT DISTINCT profile_id, route FROM profile_notification_deliveries
        WHERE profile_id = ? AND (
          status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at <= ?)
        ) ${quietClause}
      `).all(profileIdFilter, staleClaimAt, ...quietIds)
    : db.prepare(`
        SELECT DISTINCT profile_id, route FROM profile_notification_deliveries
        WHERE (status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at <= ?)) ${quietClause}
      `).all(staleClaimAt, ...quietIds)) as Array<{ profile_id: string; route: string }>;
  for (const candidate of routeCandidates) {
    const configuredRoute = Object.prototype.hasOwnProperty.call(config.profilePushRoutes, candidate.profile_id)
      ? config.profilePushRoutes[candidate.profile_id]
      : undefined;
    if (configuredRoute?.route === candidate.route) continue;
    db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'fallback', claim_token = NULL, claimed_at = NULL,
          last_error = ?, updated_at = ?
      WHERE profile_id = ? AND route = ? AND (
        status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at <= ?)
      )
    `).run(ROUTE_MISSING_ERROR, dueAt, candidate.profile_id, candidate.route, staleClaimAt);
  }

  // route 同名恢复后重新入队：仅限因 route 配置漂移进入 fallback、且尚未被
  // notify.pull 读取的行。transport/幂等窗口导致的 fallback 保持终态，避免重复投递。
  // 注意：带 profileIdFilter 的调用只恢复目标 profile，其余 profile 由全局 tick 恢复。
  for (const [configuredProfileId, configuredRoute] of Object.entries(config.profilePushRoutes)) {
    if (profileIdFilter && configuredProfileId !== profileIdFilter) continue;
    db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'pending', attempts = 0,
          request_generation = request_generation + 1,
          request_started_at = NULL, transport_failures = 0,
          next_attempt_at = ?, last_error = NULL,
          claim_token = NULL, claimed_at = NULL, updated_at = ?
      WHERE profile_id = ? AND route = ? AND status = 'fallback'
        AND last_error IN (?, ?)
        AND NOT EXISTS (
          SELECT 1 FROM profile_notification_reads r
          WHERE r.profile_id = profile_notification_deliveries.profile_id
            AND r.notification_id = profile_notification_deliveries.notification_id
        )
    `).run(
      dueAt,
      dueAt,
      configuredProfileId,
      configuredRoute.route,
      ROUTE_CHANGED_ERROR,
      ROUTE_MISSING_ERROR,
    );
  }

  const params: unknown[] = [dueAt, dueAt, staleClaimAt, ...quietIds];
  const profileClause = profileIdFilter ? "AND d.profile_id = ?" : "";
  if (profileIdFilter) params.push(profileIdFilter);
  const rows = db.prepare(`
    SELECT d.profile_id, d.notification_id, d.route, d.attempts,
           d.request_generation, d.request_started_at, d.transport_failures,
           n.source, n.title, n.body, n.created_at, n.dedupe_key
    FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE (
      (d.status IN ('pending', 'failed') AND d.next_attempt_at <= ? AND (d.not_before IS NULL OR d.not_before <= ?))
      OR (d.status = 'sending' AND d.claimed_at <= ?)
    ) ${quietClauseAliased} ${profileClause}
      AND NOT EXISTS (
        SELECT 1 FROM profile_notification_reads r
        WHERE r.profile_id = d.profile_id AND r.notification_id = d.notification_id
      )
    ORDER BY d.next_attempt_at, d.notification_id
    LIMIT 100
  `).all(...params as any[]) as Array<Record<string, unknown>>;
  const summary: DeliverySummary = { attempted: 0, sent: 0, failed: 0 };

  // 有界并发投递：最多 5 个 worker，避免逐条 10s 超时叠加成 100×10s。
  // claim 仍通过 WHERE 原子完成；每个 worker 只处理自己取到的 row。
  const DELIVERY_BUDGET_MS = 45_000;
  const startedAt = Date.now();

  async function processRow(row: Record<string, unknown>): Promise<DeliverySummary> {
    const result: DeliverySummary = { attempted: 0, sent: 0, failed: 0 };
    const profileId = String(row.profile_id);
    const notificationId = Number(row.notification_id);
    const routeName = String(row.route);
    const route = Object.prototype.hasOwnProperty.call(config.profilePushRoutes, profileId)
      ? config.profilePushRoutes[profileId]
      : undefined;
    if (!route || route.route !== routeName) return result;
    if (quiet.has(profileId)) return result;
    const requestAt = clock();
    const claimToken = crypto.randomUUID();
    const claimed = db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'sending', claim_token = ?, claimed_at = ?,
          request_started_at = COALESCE(request_started_at, ?), updated_at = ?
      WHERE profile_id = ? AND notification_id = ? AND route = ? AND (
        (status IN ('pending', 'failed') AND next_attempt_at <= ? AND (not_before IS NULL OR not_before <= ?))
        OR (status = 'sending' AND claimed_at <= ?)
      )
    `).run(
      claimToken,
      requestAt.toISOString(),
      requestAt.toISOString(),
      requestAt.toISOString(),
      profileId,
      notificationId,
      routeName,
      dueAt,
      dueAt,
      staleClaimAt,
    ) as { changes: number };
    if (claimed.changes !== 1) return result;
    result.attempted += 1;

    const body = JSON.stringify({
      event_type: "life_assistant.reminder",
      notification: {
        profileId,
        source: String(row.source),
        title: String(row.title),
        body: String(row.body),
        createdAt: String(row.created_at),
      },
    });
    const timestamp = String(Math.floor(requestAt.getTime() / 1000));
    const signature = crypto.createHmac("sha256", route.secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const requestId = `life-assistant:${profileId}:${notificationId}:${routeName}:a${Number(row.request_generation)}`;
    let confirmedHttpFailure = false;
    try {
      const response = await fetchImpl(route.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": timestamp,
          "X-Webhook-Signature-V2": signature,
          "X-Request-ID": requestId,
        },
        body,
      });
      if (!response.ok) {
        confirmedHttpFailure = true;
        throw new Error(`HTTP ${response.status}`);
      }
      db.exec("BEGIN IMMEDIATE");
      let completed: { changes: number };
      try {
        completed = db.prepare(`
          UPDATE profile_notification_deliveries
          SET status = 'sent', attempts = attempts + 1, transport_failures = 0,
              sent_at = ?, last_error = NULL, claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE profile_id = ? AND notification_id = ? AND route = ?
            AND status = 'sending' AND claim_token = ?
        `).run(
          requestAt.toISOString(),
          requestAt.toISOString(),
          profileId,
          notificationId,
          routeName,
          claimToken,
        ) as { changes: number };
        if (completed.changes === 1) {
          db.prepare(`
            INSERT OR IGNORE INTO profile_notification_reads(profile_id, notification_id, read_at)
            VALUES(?, ?, ?)
          `).run(profileId, notificationId, requestAt.toISOString());
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (completed.changes === 1) result.sent += 1;
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      const transportFailures = confirmedHttpFailure ? 0 : Number(row.transport_failures) + 1;
      const requestGeneration = Number(row.request_generation) + (confirmedHttpFailure ? 1 : 0);
      const requestStartedAt = confirmedHttpFailure
        ? null
        : row.request_started_at == null ? requestAt.toISOString() : String(row.request_started_at);
      const retrySeconds = [60, 300, 900, 3600][Math.min(attempts - 1, 3)];
      const nextAttemptAt = new Date(requestAt.getTime() + retrySeconds * 1000).toISOString();
      const nextStatus = (!confirmedHttpFailure && transportFailures >= 3)
        || (confirmedHttpFailure && attempts >= MAX_CONFIRMED_HTTP_ATTEMPTS)
        ? "fallback"
        : "failed";
      const completed = db.prepare(`
        UPDATE profile_notification_deliveries
        SET status = ?, attempts = ?, request_generation = ?, request_started_at = ?, transport_failures = ?,
            next_attempt_at = ?, last_error = ?, claim_token = NULL, claimed_at = NULL, updated_at = ?
        WHERE profile_id = ? AND notification_id = ? AND route = ?
          AND status = 'sending' AND claim_token = ?
      `).run(
        nextStatus,
        attempts,
        requestGeneration,
        requestStartedAt,
        transportFailures,
        nextAttemptAt,
        error instanceof Error ? error.message : String(error),
        requestAt.toISOString(),
        profileId,
        notificationId,
        routeName,
        claimToken,
      ) as { changes: number };
      if (completed.changes === 1) result.failed += 1;
    }
    return result;
  }

  let nextIndex = 0;
  const workerCount = Math.min(5, rows.length);
  const workers: Promise<void>[] = [];
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push((async () => {
      while (true) {
        if (Date.now() - startedAt >= DELIVERY_BUDGET_MS) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= rows.length) return;
        const result = await processRow(rows[index]);
        summary.attempted += result.attempted;
        summary.sent += result.sent;
        summary.failed += result.failed;
      }
    })());
  }
  await Promise.all(workers);

  return summary;
}

/** Compatibility name for existing global jobs. */
export const notify = (title: string, body: string, dedupeKey?: string): Promise<void> =>
  dedupeKey === undefined
    ? publishGlobal(title, body)
    : publishGlobal("general", title, body, dedupeKey);

export interface SnoozeSummary {
  notificationId: number;
  snoozedUntil: string;
  routes: string[];
}

/** 与 deliverPendingProfileNotifications 的幂等窗口保持一致的保守口径。 */
const UNCERTAIN_WINDOW_MS = 55 * 60 * 1000;

/**
 * 稍后提醒：把未成功投递的通知的下次投递时间推迟 minutes 分钟。
 * 只作用于 pending/failed/fallback；幂等窗口内的不确定失败（request_started_at 较新）
 * 拒绝 snooze，避免换新 Request-ID 重复投递。
 */
export function snoozeProfileNotificationDelivery(
  value: ProfileContext | string,
  notificationId: number,
  minutes: number,
  at = new Date(),
): SnoozeSummary {
  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    throw new Error("notificationId 必须是正整数");
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error("minutes 必须是 1–1440 之间的整数分钟");
  }
  const profile = asContext(value);
  const db = getDatabase();
  const exists = db.prepare(
    "SELECT 1 FROM profile_notifications WHERE profile_id = ? AND id = ?",
  ).get(profile.id, notificationId);
  if (!exists) throw new Error(`通知 ${notificationId} 不存在或不属于当前 Profile`);
  const rows = db.prepare(`
    SELECT route, status, request_started_at FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ? AND status IN ('pending', 'failed', 'fallback')
  `).all(profile.id, notificationId) as Array<{
    route: string;
    status: string;
    request_started_at: string | null;
  }>;
  if (rows.length === 0) {
    throw new Error(`通知 ${notificationId} 没有可推迟的投递（可能已投递成功、已取消或正在投递）`);
  }
  const cutoff = new Date(at.getTime() - UNCERTAIN_WINDOW_MS).toISOString();
  for (const row of rows) {
    if (row.status !== "pending" && row.request_started_at != null && row.request_started_at > cutoff) {
      throw new Error(
        `通知 ${notificationId} 的上一次投递结果不确定（可能仍在途），为避免重复推送暂不能推迟；请稍后再试`,
      );
    }
  }
  const snoozedUntil = new Date(at.getTime() + minutes * 60_000).toISOString();
  const updated = db.prepare(`
    UPDATE profile_notification_deliveries
    SET status = 'pending', attempts = 0, transport_failures = 0,
        next_attempt_at = ?, not_before = ?, last_error = NULL,
        claim_token = NULL, claimed_at = NULL, updated_at = ?
    WHERE profile_id = ? AND notification_id = ? AND status IN ('pending', 'failed', 'fallback')
  `).run(snoozedUntil, snoozedUntil, at.toISOString(), profile.id, notificationId) as { changes: number };
  if (updated.changes === 0) throw new Error("推迟失败：投递状态刚被并发修改，请重试");
  return { notificationId, snoozedUntil, routes: rows.map((row) => row.route) };
}

export interface CancelSummary {
  notificationId: number;
  cancelled: number;
}

/** 取消未投递的通知：pending/failed/fallback → cancelled（终态，不再被 route 恢复重新入队）。 */
export function cancelProfileNotificationDelivery(
  value: ProfileContext | string,
  notificationId: number,
): CancelSummary {
  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    throw new Error("notificationId 必须是正整数");
  }
  const profile = asContext(value);
  const db = getDatabase();
  const time = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'cancelled', claim_token = NULL, claimed_at = NULL, updated_at = ?
      WHERE profile_id = ? AND notification_id = ? AND status IN ('pending', 'failed', 'fallback')
    `).run(time, profile.id, notificationId) as { changes: number };
    // 同时标记已读：用户已明确知晓并决定取消，避免 notify.pull 再把它作为未读兜底复述。
    db.prepare(
      "INSERT OR IGNORE INTO profile_notification_reads(profile_id, notification_id, read_at) VALUES(?, ?, ?)",
    ).run(profile.id, notificationId, time);
    db.exec("COMMIT");
    return { notificationId, cancelled: updated.changes };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface NotificationDeliveryView {
  route: string;
  status: string;
}

export interface NotificationListEntry {
  id: number;
  source: string;
  title: string;
  body: string;
  createdAt: string;
  readAt?: string;
  deliveries: NotificationDeliveryView[];
}

/** 列出当前 Profile 最近的通知及投递状态（含已读，只读操作）。 */
export function listProfileNotifications(value: ProfileContext | string, limit = 20): NotificationListEntry[] {
  const profile = asContext(value);
  const bounded = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const rows = getDatabase().prepare(`
    SELECT n.id, n.source, n.title, n.body, n.created_at,
      (SELECT r.read_at FROM profile_notification_reads r
        WHERE r.profile_id = n.profile_id AND r.notification_id = n.id) AS read_at,
      (SELECT GROUP_CONCAT(route || '=' || status, ',') FROM profile_notification_deliveries d
        WHERE d.profile_id = n.profile_id AND d.notification_id = n.id) AS deliveries
    FROM profile_notifications n
    WHERE n.profile_id = ?
    ORDER BY n.id DESC
    LIMIT ?
  `).all(profile.id, bounded) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    source: String(row.source),
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.created_at),
    readAt: row.read_at == null ? undefined : String(row.read_at),
    deliveries: typeof row.deliveries === "string" && row.deliveries.length > 0
      ? row.deliveries.split(",").map((pair) => {
          const separator = pair.indexOf("=");
          return separator === -1
            ? { route: pair, status: "unknown" }
            : { route: pair.slice(0, separator), status: pair.slice(separator + 1) };
        })
      : [],
  }));
}

export function pullPending(value: ProfileContext | string): Notice[] {
  const profile = asContext(value);
  const db = getDatabase();
  const time = now();
  const staleClaimAt = new Date(new Date(time).getTime() - 2 * 60 * 1000).toISOString();
  const activeRoute = Object.prototype.hasOwnProperty.call(config.profilePushRoutes, profile.id)
    ? config.profilePushRoutes[profile.id].route
    : undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR IGNORE INTO profiles(profile_id, created_at) VALUES(?, ?)").run(profile.id, time);
    const globalRows = db.prepare(`
      SELECT n.* FROM global_notifications n
      LEFT JOIN global_notification_reads r ON r.notification_id = n.id AND r.profile_id = ?
      WHERE r.notification_id IS NULL
      ORDER BY n.id ASC LIMIT 100
    `).all(profile.id) as Record<string, unknown>[];
    const profileRows = db.prepare(`
      SELECT n.* FROM profile_notifications n
      LEFT JOIN profile_notification_reads r ON r.notification_id = n.id AND r.profile_id = ?
      WHERE n.profile_id = ? AND r.notification_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM profile_notification_deliveries d
          WHERE d.notification_id = n.id AND d.profile_id = n.profile_id
            AND (
              (? IS NOT NULL AND d.route = ? AND (d.status = 'sent' OR (d.status = 'sending' AND d.claimed_at > ?)))
              OR (? IS NULL AND d.status = 'sending' AND d.claimed_at > ?)
            )
        )
      ORDER BY n.id ASC LIMIT 100
    `).all(profile.id, profile.id, activeRoute ?? null, activeRoute ?? null, staleClaimAt, activeRoute ?? null, staleClaimAt) as Record<string, unknown>[];
    const notices = [
      ...globalRows.map((row) => noticeFromRow(row, "global")),
      ...profileRows.map((row) => noticeFromRow(row, "profile")),
    ].sort((a, b) => a.time.localeCompare(b.time) || a.id - b.id).slice(0, 100);
    const markGlobal = db.prepare("INSERT OR IGNORE INTO global_notification_reads(profile_id, notification_id, read_at) VALUES(?, ?, ?)");
    const markProfile = db.prepare("INSERT OR IGNORE INTO profile_notification_reads(profile_id, notification_id, read_at) VALUES(?, ?, ?)");
    const cancelProfileDelivery = db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'cancelled', updated_at = ?
      WHERE profile_id = ? AND notification_id = ? AND status IN ('pending', 'failed', 'fallback')
    `);
    for (const notice of notices) {
      if (notice.scope === "global") markGlobal.run(profile.id, notice.id, time);
      else {
        markProfile.run(profile.id, notice.id, time);
        cancelProfileDelivery.run(time, profile.id, notice.id);
      }
    }
    db.exec("COMMIT");
    return notices;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
