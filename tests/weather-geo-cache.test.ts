import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// N2 回归：cachedGeo 读取侧校验旧缓存。store 写入需要隔离的 DATA_DIR，
// 必须在导入 src 模块前设置（与 notification-publisher.test.ts 同一约定）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-geo-cache-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";

const { config } = await import("../src/config.js");
const { store } = await import("../src/core/store.js");
const { qweatherGeo } = await import("../src/modules/weather/provider.js");
const { getDatabase } = await import("../src/core/database.js");
const db = getDatabase();

const CACHE_KEY = "qweather:geo:北京";

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a dirty legacy geo cache is rejected and re-queried", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  // 升级前写入的脏缓存：空 id + null 坐标
  store.set(CACHE_KEY, { id: "", lat: null, lon: null, ts: Date.now() });
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    assert.match(String(input), /geo\/v2\/city\/lookup/);
    return Response.json({ location: [{ id: "101010100", lat: "39.90", lon: "116.40" }] });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  const result = await qweatherGeo("北京");
  assert.equal(calls, 1);
  assert.deepEqual(result, { id: "101010100", lat: 39.9, lon: 116.4 });
  // 脏缓存已被清除并被合法结果覆盖
  const cached = store.get<{ id: string; lat: number; lon: number }>(CACHE_KEY);
  assert.equal(cached?.id, "101010100");
});

test("an out-of-range legacy geo cache is rejected and re-queried", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  store.set(CACHE_KEY, { id: "101010100", lat: 91.5, lon: 116.4, ts: Date.now() });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ location: [{ id: "101010100", lat: "39.90", lon: "116.40" }] });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  const result = await qweatherGeo("北京");
  assert.equal(calls, 1);
  assert.deepEqual(result, { id: "101010100", lat: 39.9, lon: 116.4 });
});

test("a valid fresh cache short-circuits the GeoAPI", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  store.set(CACHE_KEY, { id: "101010100", lat: 39.9, lon: 116.4, ts: Date.now() });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ location: [] });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  const result = await qweatherGeo("北京");
  assert.equal(calls, 0);
  assert.deepEqual(result, { id: "101010100", lat: 39.9, lon: 116.4 });
});
