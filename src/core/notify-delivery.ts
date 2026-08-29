import crypto from "node:crypto";
import { config } from "../config.js";
import { getDatabase } from "./database.js";
import { renderDeliveredNotification } from "./delivery-render.js";
import { quietProfileIds } from "./notification-settings.js";
import { requireProfileContext } from "./profile.js";

/**
 * outbox 投递状态机：按 route 认领（claim token）、HMAC V2 webhook 发送、
 * 幂等窗口 fallback、route 漂移检测与恢复、有界并发重试。
 */

export interface DeliverySummary {
  attempted: number;
  sent: number;
  failed: number;
}

const MAX_CONFIRMED_HTTP_ATTEMPTS = 5;
/** route 配置漂移导致的 fallback 标记（route 恢复后可重新入队）。 */
const ROUTE_CHANGED_ERROR = "configured webhook route changed";
const ROUTE_MISSING_ERROR = "configured webhook route is missing or changed";

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
           d.not_before, d.ledger_id, n.source, n.title, n.body, n.created_at, n.dedupe_key, n.envelope
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
      AND (
        json_extract(n.envelope, '$.payload.ledgerId') IS NULL
        OR EXISTS (
          SELECT 1 FROM ledger_members lm
          WHERE lm.ledger_id = json_extract(n.envelope, '$.payload.ledgerId')
            AND lm.profile_id = d.profile_id
        )
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
      ) AND (
        NOT EXISTS (SELECT 1 FROM profile_notifications n WHERE n.id = profile_notification_deliveries.notification_id AND json_extract(n.envelope, '$.payload.ledgerId') IS NOT NULL)
        OR EXISTS (
          SELECT 1 FROM profile_notifications n
          JOIN ledger_members lm ON lm.ledger_id = json_extract(n.envelope, '$.payload.ledgerId') AND lm.profile_id = profile_notification_deliveries.profile_id
          WHERE n.id = profile_notification_deliveries.notification_id
        )
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

    // 发送前按投递时刻重渲染 schedule.reminder 的相对时间（勿扰顺延等原因在此附加）；
    // 其余 kind 或无 envelope 的存量行原样使用落库快照。
    const view = renderDeliveredNotification({
      profileId,
      title: String(row.title),
      body: String(row.body),
      envelope: row.envelope == null ? null : String(row.envelope),
      notBefore: row.not_before == null ? null : String(row.not_before),
      attempts: Number(row.attempts),
    }, requestAt);

    const body = JSON.stringify({
      event_type: "life_assistant.reminder",
      notification: {
        profileId,
        source: String(row.source),
        title: view.title,
        body: view.body,
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
        // 非 2xx 分支不消费响应体：取消流让 undici 连接可复用。
        response.body?.cancel();
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
      // 回写基于 claim 后的行现值做算术递增，而不是批量 SELECT 的快照：批量 SELECT 与
      // claim 之间行可能被 route 恢复重新入队（attempts=0、request_generation+1），
      // 用快照绝对值回写会把 generation 拨回旧值（X-Request-ID 撞号）、attempts 回退。
      // 退避档位/fallback 判定仍由快照 attempts 计算（仅决策）；存储值由 SQL 在行上原子推进。
      const attempts = Number(row.attempts) + 1;
      const transportFailures = confirmedHttpFailure ? 0 : Number(row.transport_failures) + 1;
      const retrySeconds = [60, 300, 900, 3600][Math.min(attempts - 1, 3)];
      // 退避阶梯达档位说明（不改档位数组本身）：
      // - 传输失败（结果不确定，复用同一 X-Request-ID/request_generation）第 3 次即 fallback，
      //   实际只经过 60s/300s 两档；
      // - 900s/3600s 档仅对「确认 HTTP 非 2xx」路径可达（每次换代 request_generation + 1）；
      // - 传输失败路径同时受 55 分钟幂等窗口约束：request_started_at 超期行先被幂等扫描置 fallback。
      const nextAttemptAt = new Date(requestAt.getTime() + retrySeconds * 1000).toISOString();
      const nextStatus = (!confirmedHttpFailure && transportFailures >= 3)
        || (confirmedHttpFailure && attempts >= MAX_CONFIRMED_HTTP_ATTEMPTS)
        ? "fallback"
        : "failed";
      const completed = db.prepare(`
        UPDATE profile_notification_deliveries
        SET status = ?,
            attempts = attempts + 1,
            transport_failures = CASE WHEN ? THEN 0 ELSE transport_failures + 1 END,
            request_generation = request_generation + CASE WHEN ? THEN 1 ELSE 0 END,
            request_started_at = CASE WHEN ? THEN NULL ELSE COALESCE(request_started_at, ?) END,
            next_attempt_at = ?, last_error = ?, claim_token = NULL, claimed_at = NULL, updated_at = ?
        WHERE profile_id = ? AND notification_id = ? AND route = ?
          AND status = 'sending' AND claim_token = ?
      `).run(
        nextStatus,
        confirmedHttpFailure ? 1 : 0,
        confirmedHttpFailure ? 1 : 0,
        confirmedHttpFailure ? 1 : 0,
        requestAt.toISOString(),
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
