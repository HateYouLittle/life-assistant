import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";
import { isWellFormedId } from "./profile.js";

export interface SqlRow {
  [key: string]: unknown;
}

let database: DatabaseSync | null = null;

function ensureColumn(db: DatabaseSync, table: string, name: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function migrateDatabaseSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS global_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedupe_key TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS global_notification_reads (
      profile_id TEXT NOT NULL,
      notification_id INTEGER NOT NULL REFERENCES global_notifications(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, notification_id)
    );
    CREATE TABLE IF NOT EXISTS profile_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedupe_key TEXT,
      envelope TEXT,
      UNIQUE (profile_id, dedupe_key)
    );
    CREATE TABLE IF NOT EXISTS profile_notification_reads (
      profile_id TEXT NOT NULL,
      notification_id INTEGER NOT NULL REFERENCES profile_notifications(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, notification_id)
    );
    CREATE TABLE IF NOT EXISTS profile_notification_deliveries (
      profile_id TEXT NOT NULL,
      notification_id INTEGER NOT NULL,
      route TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      request_generation INTEGER NOT NULL DEFAULT 1,
      request_started_at TEXT,
      transport_failures INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      claim_token TEXT,
      claimed_at TEXT,
      sent_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, notification_id, route),
      FOREIGN KEY (profile_id, notification_id) REFERENCES profile_notifications(profile_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS schedules (
      profile_id TEXT NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'todo',
      title TEXT NOT NULL,
      note TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      calendar TEXT NOT NULL,
      date TEXT,
      lunar_month INTEGER,
      lunar_day INTEGER,
      leap_month_policy TEXT,
      time TEXT NOT NULL DEFAULT '09:00',
      all_day INTEGER NOT NULL DEFAULT 1,
      timezone TEXT NOT NULL,
      recurrence_json TEXT NOT NULL,
      reminders_json TEXT NOT NULL,
      deadline_at TEXT,
      deadline_offset_minutes INTEGER,
      reminder_interval_minutes INTEGER,
      reminder_max_attempts INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, id)
    );
    CREATE TABLE IF NOT EXISTS schedule_occurrences (
      profile_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      occurrence_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (profile_id, schedule_id, occurrence_key),
      FOREIGN KEY (profile_id, schedule_id) REFERENCES schedules(profile_id, id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS scheduler_lease (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cn_holiday_days (
      date TEXT PRIMARY KEY,
      year INTEGER NOT NULL,
      day_type TEXT NOT NULL CHECK(day_type IN ('holiday', 'workday')),
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cn_holiday_days_year ON cn_holiday_days(year);
    CREATE TABLE IF NOT EXISTS cn_holiday_year_meta (
      year INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'ready',
      source TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      last_attempt_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS profile_settings (
      profile_id TEXT PRIMARY KEY,
      quiet_start TEXT,
      quiet_end TEXT,
      timezone TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automations (
      profile_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      condition_json TEXT,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_result TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, id)
    );
    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      owner_profile_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_members (
      ledger_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (ledger_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      owner_profile_id TEXT,
      ledger_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      archived INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      ledger_id TEXT NOT NULL,
      id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      category TEXT,
      account_id TEXT,
      to_account_id TEXT,
      occurred_at TEXT NOT NULL,
      note TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ledger_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_notifications_composite ON profile_notifications(profile_id, id);
    CREATE INDEX IF NOT EXISTS idx_profile_deliveries_due ON profile_notification_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_time ON ledger_entries(ledger_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner ON ledger_accounts(owner_profile_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_accounts_ledger ON ledger_accounts(ledger_id);
    `);

    // 版本护栏：schema_meta 表可能刚创建，读取现有 version 必须放在 CREATE 之后、事务内。
    // 现有版本比当前支持版本新时拒绝打开/迁移，避免旧代码破坏新库。
    const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value?: string } | undefined;
    if (versionRow?.value !== undefined) {
      const existingVersion = Number(versionRow.value);
      if (Number.isFinite(existingVersion) && existingVersion > 8) {
        throw new Error(`database schema version ${versionRow.value} is newer than supported version 8`);
      }
    }

    // Additive migration for databases created by early development builds.
    ensureColumn(db, "schedules", "type", "TEXT NOT NULL DEFAULT 'todo'");
    ensureColumn(db, "schedules", "priority", "TEXT NOT NULL DEFAULT 'normal'");
    ensureColumn(db, "schedules", "status", "TEXT NOT NULL DEFAULT 'active'");
    ensureColumn(db, "schedules", "all_day", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "schedules", "deadline_at", "TEXT");
    ensureColumn(db, "schedules", "deadline_offset_minutes", "INTEGER");
    ensureColumn(db, "profile_notification_deliveries", "request_generation", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "profile_notification_deliveries", "request_started_at", "TEXT");
    ensureColumn(db, "profile_notification_deliveries", "transport_failures", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "profile_notification_deliveries", "claim_token", "TEXT");
    ensureColumn(db, "profile_notification_deliveries", "claimed_at", "TEXT");
    // v5：snooze/延迟投递生效点；NULL 表示不延迟。
    ensureColumn(db, "profile_notification_deliveries", "not_before", "TEXT");
    // v6：结构化快照；投递时据此重渲染 schedule.reminder 的相对时间并附加顺延原因。
    ensureColumn(db, "profile_notifications", "envelope", "TEXT");
    // v7：待办强提醒（schedules 可选列；NULL = 未开启强提醒）。
    ensureColumn(db, "schedules", "reminder_interval_minutes", "INTEGER");
    ensureColumn(db, "schedules", "reminder_max_attempts", "INTEGER");
    // v8：记账模块（ledgers/ledger_members/ledger_accounts/ledger_entries 及索引，全量 CREATE IF NOT EXISTS）。

    db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('version', '8')").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function legacySource(notice: Record<string, unknown>): "weather" | "oilprice" | null {
  const key = typeof notice.dedupeKey === "string" ? notice.dedupeKey : "";
  const title = typeof notice.title === "string" ? notice.title : "";
  if (key.startsWith("weather:") || title.includes("气象") || title.includes("天气")) return "weather";
  if (key.startsWith("oilprice:") || title.includes("油价")) return "oilprice";
  return null;
}

function migrateLegacyJson(db: DatabaseSync): void {
  const legacyFile = path.join(config.dataDir, "store.json");
  if (!fs.existsSync(legacyFile)) return;
  const marker = db.prepare("SELECT value FROM schema_meta WHERE key = 'legacy_json_migrated'").get() as SqlRow | undefined;
  if (marker) return;

  const backup = `${legacyFile}.pre-sqlite.bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(legacyFile, backup);

  let legacy: Record<string, unknown>;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8")) as Record<string, unknown>;
  } catch {
    legacy = {};
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertKv = db.prepare("INSERT OR IGNORE INTO kv(key, value) VALUES(?, ?)");
    // notify:sent_keys / notify:seq 在 SQLite 版通知去重落地后已无任何读取者，
    // 不再搬入 kv；旧文件保留原样，靠备份即可追溯。
    const globalKeys = new Set(["location:current"]);
    for (const [key, value] of Object.entries(legacy)) {
      if (key.startsWith("qweather:geo:") || globalKeys.has(key)) {
        insertKv.run(key, JSON.stringify(value));
      }
    }

    const insertNotice = db.prepare(
      "INSERT OR IGNORE INTO global_notifications(source, title, body, created_at, dedupe_key) VALUES(?, ?, ?, ?, ?)",
    );
    const pending = Array.isArray(legacy.pending_notifications) ? legacy.pending_notifications : [];
    const legacyToNew = new Map<number, number>();
    for (const raw of pending) {
      const notice = raw as Record<string, unknown>;
      const source = legacySource(notice);
      if (!source || typeof notice.title !== "string" || typeof notice.body !== "string") continue;
      const result = insertNotice.run(
        source,
        notice.title,
        notice.body,
        typeof notice.time === "string" ? notice.time : now,
        typeof notice.dedupeKey === "string" ? notice.dedupeKey : null,
      ) as { lastInsertRowid: number | bigint };
      const row = typeof notice.dedupeKey === "string"
        ? db.prepare("SELECT id FROM global_notifications WHERE dedupe_key = ?").get(notice.dedupeKey) as { id: number } | undefined
        : undefined;
      const newId = row?.id ?? Number(result.lastInsertRowid);
      if (typeof notice.id === "number" && Number.isInteger(notice.id)) legacyToNew.set(notice.id, newId);
    }

    const insertRead = db.prepare(
      "INSERT OR IGNORE INTO global_notification_reads(profile_id, notification_id, read_at) VALUES(?, ?, ?)",
    );
    for (const [key, value] of Object.entries(legacy)) {
      if (!key.startsWith("notify:read:") || !Array.isArray(value)) continue;
      const profileId = key.slice("notify:read:".length);
      if (!isWellFormedId(profileId)) continue;
      for (const oldId of value) {
        if (typeof oldId !== "number") continue;
        const newId = legacyToNew.get(oldId);
        if (newId) insertRead.run(profileId, newId, now);
      }
    }

    db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('legacy_json_migrated', ?)").run(now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getDatabase(): DatabaseSync {
  if (database) return database;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const candidate = new DatabaseSync(path.join(config.dataDir, "life-assistant.sqlite"));
  try {
    migrateDatabaseSchema(candidate);
    migrateLegacyJson(candidate);
    database = candidate;
    return candidate;
  } catch (error) {
    candidate.close();
    throw error;
  }
}

export function resetDatabaseForTests(): void {
  database?.close();
  database = null;
}
