import { config } from "../config.js";
import { getDatabase } from "./database.js";
import { requireProfileContext } from "./profile.js";
import type { NotificationEnvelope } from "./notification.js";

/**
 * 发布与去重落库层：把一条通知写入 Profile outbox 并生成投递意图。
 *
 * 这里是 legacy dedupe key 迁移逻辑的唯一驻留地（JSON 版本升级键改名兼容）：
 * 调用方只需在信封上携带 `legacyDedupeKeys`，本层负责命中旧键时改键复用旧行，
 * 避免旧部署升级当天重复推送。
 */

export function nowIso(): string {
  return new Date().toISOString();
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

/** 单条全局事件发布的输入：source 缺省按 "general" 落库。 */
export interface PublishGlobalInput {
  source?: string;
  title: string;
  body: string;
  dedupeKey?: string;
}

/** 单个 Profile 私有通知的发布输入。 */
export interface PublishProfileInput {
  profileId: string;
  source?: string;
  title: string;
  body: string;
  dedupeKey?: string;
  /** 结构化快照：带 kind 的通知据此支持投递期重渲染（见 delivery-render）。 */
  envelope?: NotificationEnvelope;
}

/** 模块侧可注入的发布函数形状（测试替身用同一签名）。 */
export type GlobalPublishFn = (input: PublishGlobalInput) => Promise<void>;
export type ProfilePublishFn = (input: PublishProfileInput) => Promise<void>;

interface FanOutOptions {
  legacyDedupeKeys?: readonly string[];
  renderForProfile?: (profileId: string, shared: { title: string; body: string }) => { title: string; body: string };
}

/**
 * Publish one shared event to every configured Profile push route.
 * 每个 Profile 的落库快照可由 renderForProfile 独立替换；dedupe/legacy/投递
 * 创建逻辑不变。
 */
export async function publishGlobal(
  input: PublishGlobalInput,
  options: FanOutOptions = {},
): Promise<void> {
  const source = input.source ?? "general";
  const { title, body, dedupeKey } = input;
  const legacyDedupeKeys = options.legacyDedupeKeys ?? [];
  if (dedupeKey !== undefined && suppressRetainedGlobal(dedupeKey, legacyDedupeKeys)) return;
  for (const profileId of Object.keys(config.profilePushRoutes)) {
    // 每 Profile 渲染回调只替换落库快照；suppressRetainedGlobal / legacy dedupe /
    // delivery 创建逻辑一律不变（R5）。
    const rendered = options.renderForProfile
      ? options.renderForProfile(profileId, { title, body })
      : { title, body };
    await publishResolvedProfile({
      profileId,
      source,
      title: rendered.title,
      body: rendered.body,
      dedupeKey,
      legacyDedupeKeys,
    });
  }
}

/** Publish an event that can only be consumed by one Profile. */
export async function publishProfile(input: PublishProfileInput): Promise<void> {
  await publishResolvedProfile({
    ...input,
    // 历史缺省：早期位置参数签名以 schedule 为默认来源，保持不变。
    source: input.source ?? "schedule",
    legacyDedupeKeys: input.envelope?.legacyDedupeKeys,
  });
}

async function publishResolvedProfile(args: {
  profileId: string;
  source: string;
  title: string;
  body: string;
  dedupeKey?: string;
  legacyDedupeKeys?: readonly string[];
  envelope?: NotificationEnvelope;
}): Promise<void> {
  const profile = requireProfileContext(args.profileId);
  const legacyDedupeKeys = args.legacyDedupeKeys ?? [];
  const { dedupeKey, envelope } = args;
  const ledgerId = envelope && envelope.kind === "bookkeeping.shared_entry"
    ? String((envelope as { payload?: { ledgerId?: unknown } }).payload?.ledgerId ?? "") || null
    : null;
  const db = getDatabase();
  const time = nowIso();
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
        "INSERT OR IGNORE INTO profile_notifications(profile_id, source, title, body, created_at, dedupe_key, envelope) VALUES(?, ?, ?, ?, ?, ?, ?)",
      ).run(profile.id, args.source, args.title, args.body, time, dedupeKey ?? null, envelope ? JSON.stringify(envelope) : null) as {
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
    if (notificationId && ledgerId) {
      db.prepare("UPDATE profile_notification_deliveries SET ledger_id = COALESCE(ledger_id, ?) WHERE profile_id = ? AND notification_id = ?")
        .run(ledgerId, profile.id, notificationId);
    }
    const ROUTE_CHANGED_ERROR = "configured webhook route changed";
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
          next_attempt_at, created_at, updated_at, ledger_id
        ) VALUES(?, ?, ?, 'pending', 0, ?, ?, ?, ?)
      `).run(profile.id, notificationId, route.route, time, time, time, ledgerId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // All active delivery is handled by the Profile outbox.
}

/** Compatibility name for existing global jobs（封存模块 express 经由 JobContext.notify 使用）。 */
export const notify = (title: string, body: string, dedupeKey?: string): Promise<void> =>
  dedupeKey === undefined
    ? publishGlobal({ title, body })
    : publishGlobal({ title, body, dedupeKey });
