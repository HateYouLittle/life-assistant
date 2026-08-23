import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("getDatabase refuses a database whose schema version is newer than supported", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-db-version-"));
  const dbPath = path.join(dataDir, "life-assistant.sqlite");

  // 构造一个比当前支持版本(6)更新的库。
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta(key, value) VALUES('version', '9');
  `);
  legacy.close();

  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { getDatabase } = await import(`../src/core/database.js?database-version-test=1`);

  assert.throws(
    () => getDatabase(),
    (err: Error) => {
      assert.match(err.message, /database schema version 9 is newer than supported version 6/);
      return true;
    },
  );

  // 抛出时必须已回滚且未把版本覆盖为 5。
  const reopened = new DatabaseSync(dbPath);
  const row = reopened.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string };
  assert.equal(row.value, "9");
  reopened.close();
});
