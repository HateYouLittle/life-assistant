import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// F3 空气质量 + F5 生活指数。环境需在导入 src 模块前设置。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-airquality-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "airquality-profile";

const {
  aqiCategory,
  cnAqiCategory,
  parseOpenMeteoAqi,
  parseQweatherAqi,
  usAqiCategory,
} = await import("../src/modules/airquality/provider.js");
const { parseQweatherIndices, uvIndexCategory } = await import("../src/modules/weather/provider.js");
const { runDailyWeatherBrief } = await import("../src/modules/weather/index.js");
const { renderNotification } = await import("../src/core/notification.js");
import type { NotificationEnvelope } from "../src/core/notification.js";
const { airqualityModule } = await import("../src/modules/airquality/index.js");
const { getDatabase } = await import("../src/core/database.js");
const db = getDatabase();

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("CN AQI categories follow HJ 633 breakpoints", () => {
  assert.equal(cnAqiCategory(0), "优");
  assert.equal(cnAqiCategory(50), "优");
  assert.equal(cnAqiCategory(51), "良");
  assert.equal(cnAqiCategory(100), "良");
  assert.equal(cnAqiCategory(101), "轻度污染");
  assert.equal(cnAqiCategory(150), "轻度污染");
  assert.equal(cnAqiCategory(151), "中度污染");
  assert.equal(cnAqiCategory(201), "重度污染");
  assert.equal(cnAqiCategory(301), "严重污染");
});

test("US AQI categories follow EPA breakpoints", () => {
  assert.equal(usAqiCategory(30), "优");
  assert.equal(usAqiCategory(75), "中等");
  assert.equal(usAqiCategory(120), "敏感人群不健康");
  assert.equal(usAqiCategory(180), "不健康");
  assert.equal(usAqiCategory(250), "非常不健康");
  assert.equal(usAqiCategory(350), "危险");
  assert.equal(aqiCategory(60, "US"), "中等");
});

test("parseQweatherAqi maps the v7 air/now payload", () => {
  const air = parseQweatherAqi("萍乡", {
    code: "200",
    now: {
      pubTime: "2026-08-22T09:00+08:00",
      aqi: "35",
      level: "1",
      category: "优",
      primary: "NA",
      pm2p5: "12",
      pm10: "28",
      o3: "60",
      no2: "15",
      so2: "4",
    },
  });
  assert.equal(air.scale, "CN");
  assert.equal(air.aqi, 35);
  assert.equal(air.category, "优");
  assert.equal(air.primary, undefined);
  assert.deepEqual(air.pollutants, { pm25: 12, pm10: 28, o3: 60, no2: 15, so2: 4 });
  assert.equal(air.source, "和风天气");

  assert.throws(() => parseQweatherAqi("萍乡", { code: "402" }), /error code 402/);
  assert.throws(() => parseQweatherAqi("萍乡", { code: "200" }), /missing now/);
  assert.throws(() => parseQweatherAqi("萍乡", { code: "200", now: { aqi: "abc" } }), /not a finite number/);
});

test("parseOpenMeteoAqi maps the air-quality current payload onto the US scale", () => {
  const air = parseOpenMeteoAqi("萍乡", {
    current: {
      time: "2026-08-22T09:00",
      us_aqi: 88,
      pm10: 40.2,
      pm2_5: 18.5,
      ozone: 66,
      nitrogen_dioxide: 12,
      sulphur_dioxide: 3,
    },
  });
  assert.equal(air.scale, "US");
  assert.equal(air.aqi, 88);
  assert.equal(air.category, "中等");
  assert.equal(air.pollutants.pm25, 18.5);
  assert.equal(air.source, "Open-Meteo");

  assert.throws(() => parseOpenMeteoAqi("萍乡", {}), /missing current/);
  assert.throws(() => parseOpenMeteoAqi("萍乡", { current: { us_aqi: null } }), /not a finite number/);
});

test("parseQweatherIndices keeps only well-formed entries", () => {
  const indices = parseQweatherIndices({
    code: "200",
    daily: [
      { date: "2026-08-22", type: "3", name: "穿衣指数", level: "2", category: "较冷", text: "建议穿厚外套。" },
      { date: "2026-08-22", type: "5", name: "紫外线指数", level: "4", category: "强", text: "涂防晒。" },
      { date: "2026-08-22", type: "9", category: "缺 name" },
    ],
  });
  assert.equal(indices.length, 2);
  assert.deepEqual(indices[0], {
    name: "穿衣指数",
    category: "较冷",
    level: "2",
    text: "建议穿厚外套。",
  });
  assert.throws(() => parseQweatherIndices({ code: "200" }), /missing daily/);
});

test("uvIndexCategory maps deterministic level bands", () => {
  assert.equal(uvIndexCategory(1).category, "弱");
  assert.equal(uvIndexCategory(3.5).category, "中等");
  assert.equal(uvIndexCategory(5.9).category, "强");
  assert.equal(uvIndexCategory(8).category, "很强");
  assert.equal(uvIndexCategory(11).category, "极强");
});

test("daily brief includes an air-quality line when the AQI source succeeds", async () => {
  const published: Array<{ title: string; body: string; dedupeKey: string }> = [];
  await runDailyWeatherBrief({
    at: new Date("2026-08-22T01:00:00.000Z"),
    timezone: "UTC",
    getLocation: () => ({ city: "萍乡", lat: 27.6, lon: 113.7 }),
    getCurrent: async () => ({
      temperature: 28, apparent: 30, humidity: 70, windSpeed: 8, windSpeedUnit: "km/h", weatherText: "多云",
    }),
    getForecast: async () => [{
      date: "2026-08-22", tMax: 33, tMin: 25, weatherText: "多云", precipProb: 10,
    }],
    getAirQuality: async () => ({
      city: "萍乡", scale: "CN", aqi: 42, category: "优",
      pollutants: { pm25: 8 }, source: "和风天气",
    }),
    publish: async (_source, title, body, dedupeKey) => {
      published.push({ title, body, dedupeKey });
    },
  });
  assert.equal(published.length, 1);
  assert.match(published[0].body, /空气：AQI 42，优（国标）/);
});

test("daily brief still publishes when the AQI source fails", async () => {
  const published: Array<{ title: string; body: string }> = [];
  await runDailyWeatherBrief({
    at: new Date("2026-08-22T01:00:00.000Z"),
    timezone: "UTC",
    getLocation: () => ({ city: "萍乡", lat: 27.6, lon: 113.7 }),
    getCurrent: async () => ({
      temperature: 28, apparent: 30, humidity: 70, windSpeed: 8, windSpeedUnit: "km/h", weatherText: "多云",
    }),
    getForecast: async () => [{
      date: "2026-08-22", tMax: 33, tMin: 25, weatherText: "多云", precipProb: 10,
    }],
    getAirQuality: async () => {
      throw new Error("aqi provider down");
    },
    publish: async (_source, title, body) => {
      published.push({ title, body });
    },
  });
  assert.equal(published.length, 1);
  assert.doesNotMatch(published[0].body, /空气/);
});

test("air quality renders consistently in plain and markdown projections", () => {
  const notification: NotificationEnvelope = {
    kind: "weather.daily_brief",
    identity: "daily-brief:萍乡:2026-08-22",
    source: "weather",
    scope: { type: "global" },
    headline: "萍乡今天多云，25～33℃",
    generatedAt: "2026-08-22T01:00:00.000Z",
    payload: {
      city: "萍乡",
      today: { weather: "多云", minTemperatureC: 25, maxTemperatureC: 33 },
      airQuality: { scale: "US", aqi: 88, category: "中等" },
    },
  };
  const plain = renderNotification(notification, "plain");
  assert.match(plain.body, /空气：AQI 88，中等（美标）/);
  const markdown = renderNotification(notification, "qq-markdown");
  assert.match(markdown.body, /\*\*空气\*\*：AQI 88，中等（美标）/);
});

test("airquality.current tool fails fast when no location is confirmed", async () => {
  const tool = airqualityModule.tools!.find((entry) => entry.name === "current")!;
  const result = await tool.handler({}, { id: "airquality-profile" });
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /位置未确认/);
});
