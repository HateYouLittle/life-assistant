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
  db.prepare("INSERT OR IGNORE INTO profiles(profile_id, created_at) VALUES(?, ?)").run(profile.id, time);
  db.prepare(
    "INSERT OR IGNORE INTO profile_notifications(profile_id, source, title, body, created_at, dedupe_key) VALUES(?, ?, ?, ?, ?, ?)",
  ).run(profile.id, source, title, body, time, dedupeKey ?? null);
  // Profile-scoped events intentionally do not use the global stdout/webhook fanout.
}

/** Compatibility name for existing global jobs. */
export const notify = (title: string, body: string, dedupeKey?: string): Promise<void> =>
  publishGlobal("general", title, body, dedupeKey);

export function pullPending(value: ProfileContext | string): Notice[] {
  const profile = asContext(value);
  const db = getDatabase();
  const time = now();
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
      ORDER BY n.id ASC LIMIT 100
    `).all(profile.id, profile.id) as Record<string, unknown>[];
    const notices = [
      ...globalRows.map((row) => noticeFromRow(row, "global")),
      ...profileRows.map((row) => noticeFromRow(row, "profile")),
    ].sort((a, b) => a.time.localeCompare(b.time) || a.id - b.id).slice(0, 100);
    const markGlobal = db.prepare("INSERT OR IGNORE INTO global_notification_reads(profile_id, notification_id, read_at) VALUES(?, ?, ?)");
    const markProfile = db.prepare("INSERT OR IGNORE INTO profile_notification_reads(profile_id, notification_id, read_at) VALUES(?, ?, ?)");
    for (const notice of notices) {
      if (notice.scope === "global") markGlobal.run(profile.id, notice.id, time);
      else markProfile.run(profile.id, notice.id, time);
    }
    db.exec("COMMIT");
    return notices;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
