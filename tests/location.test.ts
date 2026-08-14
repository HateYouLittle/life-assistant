import assert from "node:assert/strict";
import test from "node:test";

import { locationSetSchema } from "../src/core/location.js";

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
