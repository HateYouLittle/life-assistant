import assert from "node:assert/strict";
import test from "node:test";
import {
  weatherCacheClear,
  weatherCacheGet,
  weatherCacheKey,
  weatherCacheSet,
} from "../src/server/routes/weather.js";

test("weather cache is a no-op miss on an empty cache", () => {
  weatherCacheClear();
  assert.equal(weatherCacheGet("k"), undefined);
});

test("weather cache returns a cached value while fresh", () => {
  weatherCacheClear();
  weatherCacheSet("k", { current: 1 }, 1_000);
  assert.deepEqual(weatherCacheGet("k", 300_000, 5_000), { current: 1 });
});

test("weather cache expires after the TTL", () => {
  weatherCacheClear();
  weatherCacheSet("k", { current: 1 }, 0);
  assert.equal(weatherCacheGet("k", 300_000, 300_001), undefined);
});

test("weather cache keys incorporate the location", () => {
  assert.equal(
    weatherCacheKey({ city: "北京", lat: 39.9, lon: 116.4 }),
    "39.900,116.400,北京",
  );
  assert.notEqual(
    weatherCacheKey({ city: "北京", lat: 39.9, lon: 116.4 }),
    weatherCacheKey({ city: "上海", lat: 31.2, lon: 121.5 }),
  );
});

test("weather cache clears when it grows beyond the bound", () => {
  weatherCacheClear();
  for (let i = 0; i < 300; i += 1) {
    weatherCacheSet(`k${i}`, { i }, 1000);
  }
  // 超过 256 个键后 Set 会主动 clear，因此旧键不再命中。
  assert.equal(weatherCacheGet("k0", 300_000, 2000), undefined);
});
