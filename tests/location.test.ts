import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { config } from "../src/config.js";
import { resetDatabaseForTests } from "../src/core/database.js";
import { currentLocation, locationSetSchema } from "../src/modules/location/index.js";

test("location.set accepts a detected province while preserving legacy inputs", () => {
  assert.deepEqual(
    locationSetSchema.parse({ city: "朔城区", province: "山西省", lat: 39.32, lon: 112.43 }),
    { city: "朔城区", province: "山西省", lat: 39.32, lon: 112.43 },
  );
  assert.deepEqual(
    locationSetSchema.parse({ city: "萍乡", lat: 27.62, lon: 113.85 }),
    { city: "萍乡", lat: 27.62, lon: 113.85 },
  );
});

test("location.set rejects empty city, overlong city, and out-of-range coordinates", () => {
  assert.throws(() => locationSetSchema.parse({ city: "", lat: 39.32, lon: 112.43 }));
  assert.throws(() => locationSetSchema.parse({ city: "a".repeat(65), lat: 39.32, lon: 112.43 }));
  assert.throws(() => locationSetSchema.parse({ city: "北京", lat: 90.5, lon: 112.43 }));
  assert.throws(() => locationSetSchema.parse({ city: "北京", lat: -90.5, lon: 112.43 }));
  assert.throws(() => locationSetSchema.parse({ city: "北京", lat: 39.32, lon: 180.5 }));
  assert.throws(() => locationSetSchema.parse({ city: "北京", lat: 39.32, lon: -180.5 }));
});

test("location.set accepts boundary coordinates and rejects NaN/Infinity", () => {
  assert.deepEqual(
    locationSetSchema.parse({ city: "北京", lat: 90, lon: 180 }),
    { city: "北京", lat: 90, lon: 180 },
  );
  assert.deepEqual(
    locationSetSchema.parse({ city: "北京", lat: -90, lon: -180 }),
    { city: "北京", lat: -90, lon: -180 },
  );
  assert.throws(() => locationSetSchema.parse({ city: "北京", lat: Number.NaN, lon: 112.43 }));
  assert.throws(() => locationSetSchema.parse({ city: "北京", lat: 39.32, lon: Number.POSITIVE_INFINITY }));
});

test("currentLocation env branch ignores blank or overlong city", (t) => {
  const original = {
    dataDir: config.dataDir,
    city: config.location.city,
    lat: config.location.lat,
    lon: config.location.lon,
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-location-"));
  config.dataDir = dataDir;
  t.after(() => {
    config.dataDir = original.dataDir;
    config.location.city = original.city;
    config.location.lat = original.lat;
    config.location.lon = original.lon;
    resetDatabaseForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // 使用独立临时 DATA_DIR，确保 store 中没有已确认位置，测试只命中 env 分支。
  for (const city of ["", "   ", "a".repeat(65)]) {
    config.location.city = city;
    config.location.lat = 39.9;
    config.location.lon = 116.4;
    assert.equal(currentLocation(), null, `city ${JSON.stringify(city)} should be treated as unset`);
  }

  config.location.city = "北京";
  config.location.lat = 39.9;
  config.location.lon = 116.4;
  const loc = currentLocation();
  assert.ok(loc, "valid env city should produce an env-sourced location");
  assert.equal(loc?.city, "北京");
  assert.equal(loc?.source, "env");
});
