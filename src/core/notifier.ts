import crypto from "node:crypto";
import { config } from "../config.js";
import { getDatabase } from "./database.js";
import { requireProfileContext, type ProfileContext } from "./profile.js";
import { httpJson } from "./http.js";

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

interface Channel {
  name: string;
  send: (n: Notice) => Promise<void>;
}

const channels: Channel[] = [
  {
    name: "stdout",
    send: async (n) => {
      console.log(`\n[NOTIFY ${n.time}] ${n.title}\n${n.body}\n`);
    },
  },
  ...(config.notify.webhookUrl
    ? [{
        name: "webhook",
        send: async (n: Notice) => httpJson(config.notify.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(n),
        }),
      } as Channel]
    : []),
  ...(config.notify.barkUrl
    ? [{
        name: "bark",
        send: async (n: Notice) => httpJson(`${config.notify.barkUrl.replace(/\/$/, "")}/${encodeURIComponent(n.title)}/${encodeURIComponent(n.body)}`),
      } as Channel]
    : []),
  ...(config.notify.serverchanSendKey
    ? [{
        name: "serverchan",
        send: async (n: Notice) => httpJson(`https://sctapi.ftqq.com/${config.notify.serverchanSendKey}.send`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `title=${encodeURIComponent(n.title)}&desp=${encodeURIComponent(n.body)}`,
        }),
      } as Channel]
    : []),
];

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

async function fanoutGlobal(notice: Notice): Promise<void> {
  await Promise.allSettled(channels.map((channel) => channel.send(notice)));
}

/** Publish one shared event. Supports (source, title, body, key) and (title, body, key). */
export async function publishGlobal(sourceOrTitle: string, titleOrBody: string, bodyOrKey?: string, maybeDedupeKey?: string): Promise<void> {
  const hasSource = maybeDedupeKey !== undefined;
  const source = hasSource ? sourceOrTitle : "general";
  const title = hasSource ? titleOrBody : sourceOrTitle;
  const body = hasSource ? bodyOrKey ?? "" : titleOrBody;
  const dedupeKey = hasSource ? maybeDedupeKey : bodyOrKey;
  const db = getDatabase();
  const time = now();
  const result = db.prepare(
    "INSERT OR IGNORE INTO global_notifications(source, title, body, created_at, dedupe_key) VALUES(?, ?, ?, ?, ?)",
  ).run(source, title, body, time, dedupeKey ?? null) as { changes: number; lastInsertRowid: number | bigint };
  if (!result.changes) return;
  const id = Number(result.lastInsertRowid);
  const row = db.prepare("SELECT * FROM global_notifications WHERE id = ?").get(id) as Record<string, unknown>;
  await fanoutGlobal(noticeFromRow(row, "global"));
}

/** Publish an event that can only be consumed by one Profile. */
export async function publishProfile(profileId: string, sourceOrTitle: string, titleOrBody: string, bodyOrKey?: string, maybeDedupeKey?: string): Promise<void> {
  const profile = requireProfileContext(profileId);
  const hasSource = maybeDedupeKey !== undefined;
  const source = hasSource ? sourceOrTitle : "schedule";
  const title = hasSource ? titleOrBody : sourceOrTitle;
  const body = hasSource ? bodyOrKey ?? "" : titleOrBody;
  const dedupeKey = hasSource ? maybeDedupeKey : bodyOrKey;
  const db = getDatabase();
  const time = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR IGNORE INTO profiles(profile_id, created_at) VALUES(?, ?)").run(profile.id, time);
    const inserted = db.prepare(
      "INSERT OR IGNORE INTO profile_notifications(profile_id, source, title, body, created_at, dedupe_key) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(profile.id, source, title, body, time, dedupeKey ?? null) as { changes: number; lastInsertRowid: number | bigint };
    const notificationId = inserted.changes
      ? Number(inserted.lastInsertRowid)
      : Number((db.prepare(
          "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
        ).get(profile.id, dedupeKey ?? null) as { id?: number } | undefined)?.id ?? 0);
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
            last_error = 'configured webhook route changed', updated_at = ?
        WHERE profile_id = ? AND notification_id = ? AND route <> ?
          AND status IN ('pending', 'failed', 'fallback')
      `).run(time, profile.id, notificationId, route.route);
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
  // Profile-scoped events intentionally do not use the global stdout/webhook fanout.
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

  const routeCandidates = (profileIdFilter
    ? db.prepare(`
        SELECT DISTINCT profile_id, route FROM profile_notification_deliveries
        WHERE profile_id = ? AND (
          status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at <= ?)
        )
      `).all(profileIdFilter, staleClaimAt)
    : db.prepare(`
        SELECT DISTINCT profile_id, route FROM profile_notification_deliveries
        WHERE status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at <= ?)
      `).all(staleClaimAt)) as Array<{ profile_id: string; route: string }>;
  for (const candidate of routeCandidates) {
    const configuredRoute = Object.prototype.hasOwnProperty.call(config.profilePushRoutes, candidate.profile_id)
      ? config.profilePushRoutes[candidate.profile_id]
      : undefined;
    if (configuredRoute?.route === candidate.route) continue;
    db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'fallback', claim_token = NULL, claimed_at = NULL,
          last_error = 'configured webhook route is missing or changed', updated_at = ?
      WHERE profile_id = ? AND route = ? AND (
        status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at <= ?)
      )
    `).run(dueAt, candidate.profile_id, candidate.route, staleClaimAt);
  }

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

  const params: unknown[] = [dueAt, staleClaimAt];
  const profileClause = profileIdFilter ? "AND d.profile_id = ?" : "";
  if (profileIdFilter) params.push(profileIdFilter);
  const rows = db.prepare(`
    SELECT d.profile_id, d.notification_id, d.route, d.attempts,
           d.request_generation, d.request_started_at, d.transport_failures,
           n.source, n.title, n.body, n.created_at, n.dedupe_key
    FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE (
      (d.status IN ('pending', 'failed') AND d.next_attempt_at <= ?)
      OR (d.status = 'sending' AND d.claimed_at <= ?)
    ) ${profileClause}
    ORDER BY d.next_attempt_at, d.notification_id
    LIMIT 100
  `).all(...params as any[]) as Array<Record<string, unknown>>;
  const summary: DeliverySummary = { attempted: 0, sent: 0, failed: 0 };

  for (const row of rows) {
    const profileId = String(row.profile_id);
    const notificationId = Number(row.notification_id);
    const routeName = String(row.route);
    const route = Object.prototype.hasOwnProperty.call(config.profilePushRoutes, profileId)
      ? config.profilePushRoutes[profileId]
      : undefined;
    if (!route || route.route !== routeName) continue;
    const requestAt = clock();
    const claimToken = crypto.randomUUID();
    const claimed = db.prepare(`
      UPDATE profile_notification_deliveries
      SET status = 'sending', claim_token = ?, claimed_at = ?,
          request_started_at = COALESCE(request_started_at, ?), updated_at = ?
      WHERE profile_id = ? AND notification_id = ? AND route = ? AND (
        (status IN ('pending', 'failed') AND next_attempt_at <= ?)
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
      staleClaimAt,
    ) as { changes: number };
    if (claimed.changes !== 1) continue;
    summary.attempted += 1;

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
        redirect: "error",
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
      if (completed.changes === 1) summary.sent += 1;
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      const transportFailures = confirmedHttpFailure ? 0 : Number(row.transport_failures) + 1;
      const requestGeneration = Number(row.request_generation) + (confirmedHttpFailure ? 1 : 0);
      const requestStartedAt = confirmedHttpFailure
        ? null
        : row.request_started_at == null ? requestAt.toISOString() : String(row.request_started_at);
      const retrySeconds = [60, 300, 900, 3600][Math.min(attempts - 1, 3)];
      const nextAttemptAt = new Date(requestAt.getTime() + retrySeconds * 1000).toISOString();
      const nextStatus = !confirmedHttpFailure && transportFailures >= 3 ? "fallback" : "failed";
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
      if (completed.changes === 1) summary.failed += 1;
    }
  }
  return summary;
}

/** Compatibility name for existing global jobs. */
export const notify = (title: string, body: string, dedupeKey?: string): Promise<void> =>
  publishGlobal("general", title, body, dedupeKey);

export function pullPending(value: ProfileContext | string): Notice[] {
  const profile = asContext(value);
  const db = getDatabase();
  const time = now();
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
              (? IS NOT NULL AND d.route = ? AND d.status IN ('sent', 'sending'))
              OR (? IS NULL AND d.status = 'sending')
            )
        )
      ORDER BY n.id ASC LIMIT 100
    `).all(profile.id, profile.id, activeRoute ?? null, activeRoute ?? null, activeRoute ?? null) as Record<string, unknown>[];
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
