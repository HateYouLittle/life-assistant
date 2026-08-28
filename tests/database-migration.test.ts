import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// §6a：migrateLegacyJson（src/core/database.ts 内部迁移）端到端测试
//   - 临时 DATA_DIR 构造 store.json（qweather:geo:* / location:current /
//     pending_notifications / notify:read:* 等键）
//   - getDatabase() 首次打开触发迁移：断言 kv / global_notifications /
//     global_notification_reads 迁移内容、.pre-sqlite.bak 备份生成
//   - resetDatabaseForTests() 后二次打开幂等：marker 生效、不重复迁移
// ---------------------------------------------------------------------------

test("getDatabase migrates a legacy store.json into SQLite tables and is idempotent", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-db-migration-"));
  const legacyStore = {
    "qweather:geo:北京": { id: "101010100", name: "北京" },
    "qweather:geo:上海": { id: "101020100", name: "上海" },
    "location:current": { city: "北京", lat: 39.9, lon: 116.4, source: "env", confirmedAt: "2026-01-01T00:00:00.000Z" },
    // notify:sent_keys / notify:seq 在 SQLite 版通知去重落地后无任何读取者，不得搬入 kv
    "notify:sent_keys": ["weather:old:1"],
    "notify:seq": 7,
    pending_notifications: [
      { id: 1, source: "weather", title: "气象预警", body: "蓝色预警原文", time: "2026-01-01T08:00:00.000Z", dedupeKey: "weather:alert:legacy:1" },
      { id: 2, source: "oilprice", title: "油价调整", body: "92# 从 7.2 上调至 7.4", time: "2026-01-02T00:00:00.000Z", dedupeKey: "oilprice:watch:legacy:1" },
      // 无 weather/oilprice 来源判定（key 无前缀、title 无关键词）→ 跳过
      { id: 3, title: "无来源通知", body: "不应迁移" },
    ],
    // 读取记录按旧 id 映射到新行 id；99 无对应新行 → 忽略
    "notify:read:profile-a": [1, 2],
    "notify:read:profile-b": [2, 99],
    // 非法 profile id（含空格）→ 整组跳过
    "notify:read:bad id!": [1],
  };
  const storePath = path.join(dataDir, "store.json");
  fs.writeFileSync(storePath, JSON.stringify(legacyStore));

  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const databaseModule = await import(`../src/core/database.js?database-migration-test=1`);
  const { getDatabase, resetDatabaseForTests } = databaseModule as {
    getDatabase: () => import("node:sqlite").DatabaseSync;
    resetDatabaseForTests: () => void;
  };

  // --- 首次打开触发迁移 ---
  const db = getDatabase();

  // kv：只迁移 qweather:geo:* 与 location:current，等价 JSON.stringify 值
  const kvRows = db.prepare("SELECT key, value FROM kv ORDER BY key").all() as Array<{ key: string; value: string }>;
  assert.deepEqual(
    kvRows.map((row) => row.key),
    ["location:current", "qweather:geo:上海", "qweather:geo:北京"],
  );
  const kvByKey = new Map(kvRows.map((row) => [row.key, row.value]));
  assert.equal(kvByKey.get("qweather:geo:北京"), JSON.stringify(legacyStore["qweather:geo:北京"]));
  assert.equal(kvByKey.get("qweather:geo:上海"), JSON.stringify(legacyStore["qweather:geo:上海"]));
  assert.equal(kvByKey.get("location:current"), JSON.stringify(legacyStore["location:current"]));
  assert.ok(!kvByKey.has("notify:sent_keys"), "notify:sent_keys 不得搬入 kv");
  assert.ok(!kvByKey.has("notify:seq"), "notify:seq 不得搬入 kv");
  assert.ok(!kvByKey.has("pending_notifications"), "pending_notifications 不得整体搬入 kv");

  // global_notifications：weather + oilprice 两条有来源的 pending 通知；无来源的第 3 条跳过
  const notices = db.prepare(
    "SELECT source, title, body, created_at, dedupe_key FROM global_notifications ORDER BY id",
  ).all() as Array<{ source: string; title: string; body: string; created_at: string; dedupe_key: string | null }>;
  assert.equal(notices.length, 2);
  assert.ok(notices.some((notice) =>
    notice.source === "weather"
    && notice.title === "气象预警"
    && notice.body === "蓝色预警原文"
    && notice.created_at === "2026-01-01T08:00:00.000Z"
    && notice.dedupe_key === "weather:alert:legacy:1"));
  assert.ok(notices.some((notice) =>
    notice.source === "oilprice"
    && notice.title === "油价调整"
    && notice.body === "92# 从 7.2 上调至 7.4"
    && notice.created_at === "2026-01-02T00:00:00.000Z"
    && notice.dedupe_key === "oilprice:watch:legacy:1"));

  // global_notification_reads：按旧 id → 新 id 映射；profile-a 读 [1,2]、profile-b 只读 [2]；
  // "bad id!" 与 99 被跳过
  const weatherId = (db.prepare("SELECT id FROM global_notifications WHERE dedupe_key = ?").get("weather:alert:legacy:1") as { id: number }).id;
  const oilId = (db.prepare("SELECT id FROM global_notifications WHERE dedupe_key = ?").get("oilprice:watch:legacy:1") as { id: number }).id;
  const reads = db.prepare(
    "SELECT profile_id, notification_id FROM global_notification_reads ORDER BY profile_id, notification_id",
  ).all() as Array<{ profile_id: string; notification_id: number }>;
  // node:sqlite 返回 null-prototype 行对象，先铺平为普通对象再比较
  assert.deepEqual(reads.map((row) => ({ ...row })), [
    { profile_id: "profile-a", notification_id: weatherId },
    { profile_id: "profile-a", notification_id: oilId },
    { profile_id: "profile-b", notification_id: oilId },
  ]);

  // 备份文件生成且内容与旧文件一致；旧文件本身保留（迁移不删除/改写 store.json）
  const backupPath = path.join(dataDir, "store.json.pre-sqlite.bak");
  assert.ok(fs.existsSync(backupPath), "必须生成 .pre-sqlite.bak 备份");
  assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, "utf8")), legacyStore);
  assert.deepEqual(JSON.parse(fs.readFileSync(storePath, "utf8")), legacyStore);

  // marker 落库
  const marker = db.prepare("SELECT value FROM schema_meta WHERE key = 'legacy_json_migrated'").get() as { value: string } | undefined;
  assert.ok(marker && marker.value.length > 0, "必须写入 legacy_json_migrated marker");

  // --- 二次打开幂等：marker 生效，不重复迁移 ---
  resetDatabaseForTests();
  const db2 = getDatabase();
  const countOf = (table: "kv" | "global_notifications" | "global_notification_reads"): number =>
    Number((db2.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
  assert.equal(countOf("kv"), 3, "二次打开不得重复写入 kv");
  assert.equal(countOf("global_notifications"), 2, "二次打开不得重复迁移通知");
  assert.equal(countOf("global_notification_reads"), 3, "二次打开不得重复迁移读取记录");
  const marker2 = db2.prepare("SELECT value FROM schema_meta WHERE key = 'legacy_json_migrated'").get() as { value: string } | undefined;
  assert.ok(marker2, "二次打开后 marker 仍存在");

  db2.close();
});