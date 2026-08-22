import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-migration-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "migration-profile";

const databaseModule = await import("../src/core/database.js");
const { migrateDatabaseSchema, resetDatabaseForTests } = databaseModule;
const { hydrateRow, createSchedule, getSchedule } = await import("../src/modules/schedule/service.js");
const { requireProfileContext } = await import("../src/core/profile.js");

test.after(() => {
  resetDatabaseForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

test("schema v3 additively upgrades legacy schedules without touching protected tables or data", () => {
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta(key, value) VALUES('version', '3');
    CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE profile_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedupe_key TEXT,
      UNIQUE(profile_id, dedupe_key)
    );
    CREATE TABLE profile_notification_deliveries (
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
      FOREIGN KEY (profile_id, notification_id)
        REFERENCES profile_notifications(profile_id, id) ON DELETE CASCADE
    );
    CREATE TABLE schedules (
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
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, id)
    );
    CREATE TABLE schedule_occurrences (
      profile_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      occurrence_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (profile_id, schedule_id, occurrence_key),
      FOREIGN KEY (profile_id, schedule_id)
        REFERENCES schedules(profile_id, id) ON DELETE CASCADE
    );
    INSERT INTO profiles VALUES('legacy-profile', '2026-01-01T00:00:00.000Z');
    INSERT INTO schedules VALUES(
      'legacy-profile', 'legacy-schedule', 'todo', 'legacy title', NULL, 'normal', 'active',
      'solar', '2026-08-08', NULL, NULL, NULL, '09:00', 0, 'Asia/Shanghai',
      '{"frequency":"once","interval":1,"calendar":"solar"}',
      '[{"id":"legacy-reminder","minutesBefore":0}]', 1,
      '2026-08-08T01:00:00.000Z', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO schedule_occurrences VALUES(
      'legacy-profile', 'legacy-schedule', 'legacy-key', '2026-08-08T01:00:00.000Z', 'notified'
    );
    INSERT INTO profile_notifications(
      profile_id, source, title, body, created_at, dedupe_key
    ) VALUES(
      'legacy-profile', 'schedule', 'legacy notice', 'legacy body',
      '2026-08-08T01:00:00.000Z', 'schedule:legacy'
    );
  `);
  const protectedTables = [
    "profiles",
    "profile_notifications",
    "profile_notification_deliveries",
    "schedule_occurrences",
  ];
  const protectedColumns = Object.fromEntries(
    protectedTables.map((table) => [table, columnNames(legacy, table)]),
  );

  migrateDatabaseSchema(legacy);
  migrateDatabaseSchema(legacy);

  assert.equal(
    (legacy.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }).value,
    "5",
  );
  assert.ok(columnNames(legacy, "schedules").includes("deadline_at"));
  assert.ok(columnNames(legacy, "schedules").includes("deadline_offset_minutes"));
  // v5 对 deliveries 的 additive 新列：只允许在表尾追加，不得改动既有列。
  const additiveColumns: Record<string, string[]> = {
    profile_notification_deliveries: ["not_before"],
  };
  for (const table of protectedTables) {
    assert.deepEqual(
      columnNames(legacy, table),
      [...protectedColumns[table], ...(additiveColumns[table] ?? [])],
    );
  }
  assert.deepEqual(legacy.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal((legacy.prepare("SELECT COUNT(*) AS count FROM profiles").get() as { count: number }).count, 1);
  assert.equal((legacy.prepare("SELECT COUNT(*) AS count FROM schedule_occurrences").get() as { count: number }).count, 1);
  assert.equal((legacy.prepare("SELECT body FROM profile_notifications").get() as { body: string }).body, "legacy body");

  const row = legacy.prepare("SELECT * FROM schedules WHERE id = 'legacy-schedule'").get() as Record<string, unknown>;
  const item = hydrateRow(row);
  assert.equal(item.deadlineAt, undefined);
  assert.equal(item.deadlineOffsetMinutes, undefined);
  assert.equal(item.reminders[0].target, "occurrence");
  legacy.close();
});

test("new schedule writes persist deadline columns and reminder targets", () => {
  const profile = requireProfileContext("migration-profile");
  const created = createSchedule(profile, {
    title: "persisted deadline",
    calendar: "solar",
    date: "2099-02-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    deadlineAt: "2099-02-01T18:00",
    reminders: [
      { id: "start", minutesBefore: 30 },
      { id: "due", minutesBefore: 10, target: "deadline" },
    ],
  });
  const loaded = getSchedule(profile, created.id);

  assert.equal(created.deadlineAt, "2099-02-01T10:00:00.000Z");
  assert.equal(loaded.deadlineAt, "2099-02-01T10:00:00.000Z");
  assert.equal(loaded.deadlineOffsetMinutes, undefined);
  assert.deepEqual(loaded.reminders, [
    { id: "start", minutesBefore: 30, target: "occurrence" },
    { id: "due", minutesBefore: 10, target: "deadline" },
  ]);
});
