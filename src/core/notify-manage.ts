import { config } from "../config.js";
import { getDatabase } from "./database.js";
import { renderDeliveredNotification } from "./delivery-render.js";
import { requireProfileContext, type ProfileContext } from "./profile.js";

/**
 * 用户操作层：notify.pull / notify.list / snooze / cancel。
 * 这些操作面向单个 Profile，pull 是用户主动拉取，不受静默时段限制。
 */

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
  const exists = db.prepare(
    "SELECT 1 FROM profile_notifications WHERE profile_id = ? AND id = ?",
  ).get(profile.id, notificationId);
  if (!exists) throw new Error(`通知 ${notificationId} 不存在或不属于当前 Profile`);
  const time = new Date().toISOString();
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

export function pullPending(value: ProfileContext | string, at: Date = new Date()): Notice[] {
  const profile = asContext(value);
  const db = getDatabase();
  const time = at.toISOString();
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
      SELECT n.*,
        (SELECT MAX(d.attempts) FROM profile_notification_deliveries d
          WHERE d.profile_id = n.profile_id AND d.notification_id = n.id) AS pull_attempts,
        (SELECT MIN(d.not_before) FROM profile_notification_deliveries d
          WHERE d.profile_id = n.profile_id AND d.notification_id = n.id AND d.not_before IS NOT NULL) AS pull_not_before
      FROM profile_notifications n
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
      ...profileRows.map((row) => {
        // 拉取与主动投递同一套重渲染口径：顺延后的相对时间按拉取时刻重算。
        const view = renderDeliveredNotification({
          profileId: profile.id,
          title: String(row.title),
          body: String(row.body),
          envelope: row.envelope == null ? null : String(row.envelope),
          notBefore: row.pull_not_before == null ? null : String(row.pull_not_before),
          attempts: row.pull_attempts == null ? 0 : Number(row.pull_attempts),
        }, at);
        return noticeFromRow({ ...row, title: view.title, body: view.body }, "profile");
      }),
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
