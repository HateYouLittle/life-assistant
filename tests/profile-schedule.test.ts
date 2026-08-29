import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DateTime } from "luxon";
import { Lunar, Solar } from "lunar-javascript";
import type { WeatherAlert } from "../src/modules/weather/provider.js";
import type { LeapMonthPolicy } from "../src/modules/schedule/types.js";
import type { NotificationEnvelope, NotificationRenderTarget } from "../src/core/notification.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-test-"));
const testSecretA = crypto.createHash("sha256").update("profile-a test fixture").digest("hex");
const testSecretB = crypto.createHash("sha256").update("profile-b test fixture").digest("hex");
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";
process.env.PROFILE_PUSH_ROUTES_JSON = JSON.stringify({
  "profile-a": {
    route: "qqbot",
    url: "http://127.0.0.1:8644/webhooks/life-assistant-reminder",
    secret: testSecretA,
  },
  "profile-b": {
    route: "qqbot",
    url: "http://127.0.0.1:8645/webhooks/life-assistant-reminder",
    secret: testSecretB,
  },
});

const { publishNotification } = await import("../src/core/notification-publisher.js");
const { renderNotification } = await import("../src/core/notification.js");
// 模块渲染器注册：kind 渲染已下放各业务模块（生产由 modules/index 全量加载）。
await import("../src/modules/weather/notification.js");
await import("../src/modules/schedule/notification.js");
const { requireProfileContext } = await import("../src/core/profile.js");
const configModule = await import("../src/config.js");
const parseProfilePushRoutes = (configModule as Record<string, unknown>).parseProfilePushRoutes as (
  raw?: string,
) => Record<string, { route: string; url: string; secret: string }>;
const {
  createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule, hydrateRow,
  logHydrationError, hydrationErrorLogSize, resetHydrationErrorLog,
} = await import(
  "../src/modules/schedule/service.js",
);
const notifierModule = await import("../src/core/notifier.js");
const { notify, publishGlobal, publishProfile, pullPending } = notifierModule;
const deliverPendingProfileNotifications = (notifierModule as Record<string, unknown>).deliverPendingProfileNotifications as (
  options: { at: Date; profileId?: string; fetchImpl: typeof fetch; clock?: () => Date },
) => Promise<{ attempted: number; sent: number; failed: number }>;
const databaseModule = await import("../src/core/database.js");
const { getDatabase } = databaseModule;
const migrateDatabaseSchema = (databaseModule as Record<string, unknown>).migrateDatabaseSchema as (db: DatabaseSync) => void;
const schedulerModule = await import("../src/scheduler.js");
// runDueSchedules（到期扫描）的权威实现已迁入 schedule 模块，经 tick 扩展点接入。
const { runDueSchedules } = await import("../src/modules/schedule/tick.js");
const { acquireSchedulerLease, refreshSchedulerLease, releaseSchedulerLease } = schedulerModule;
const runSchedulerTick = (schedulerModule as Record<string, unknown>).runSchedulerTick as (
  at: Date,
  fetchImpl: typeof fetch,
) => Promise<{ attempted: number; sent: number; failed: number }>;
const weatherModule = await import("../src/modules/weather/index.js");
const runDailyWeatherBrief = (weatherModule as Record<string, unknown>).runDailyWeatherBrief as (options: {
  at: Date;
  timezone: string;
  getLocation: () => { city: string; lat: number; lon: number };
  getCurrent: () => Promise<{ temperature: number; apparent: number; humidity: number; windSpeed: number; windSpeedUnit: "km/h"; weatherText: string }>;
  getForecast: () => Promise<Array<{
    date: string;
    tMax: number;
    tMin: number;
    weatherText: string;
    precipProb?: number;
    precipAmountMm?: number;
  }>>;
  publish?: (source: string, title: string, body: string, dedupeKey: string) => Promise<void>;
}) => Promise<void>;
const runWeatherAlertsCheck = (weatherModule as Record<string, unknown>).runWeatherAlertsCheck as (options: {
  at?: Date;
  timezone?: string;
  getLocation?: () => { city: string; lat: number; lon: number } | null;
  getAlerts?: (city: string, lat: number, lon: number) => Promise<WeatherAlert[]>;
  publish?: (source: string, title: string, body: string, dedupeKey: string) => Promise<void>;
}) => Promise<void>;

const db = getDatabase();

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("push routes accept only strong loopback webhook configurations", () => {
  assert.equal(typeof parseProfilePushRoutes, "function");
  const strongA = testSecretA;
  const strongB = testSecretB;
  const routes = parseProfilePushRoutes(JSON.stringify({
    default: { route: "qqbot", url: "http://127.0.0.1:8644/webhooks/reminder", secret: strongA },
    constructor: { route: "qqbot", url: "http://[::1]:8645/webhooks/reminder", secret: strongB },
    external: { route: "qqbot", url: "https://example.com/webhooks/reminder", secret: strongA },
    credentials: { route: "qqbot", url: "http://user:pass@127.0.0.1:8644/webhooks/reminder", secret: strongA },
    localhostRoute: { route: "qqbot", url: "http://localhost:8644/webhooks/reminder", secret: strongA },
    repetitive: { route: "qqbot", url: "http://127.0.0.1:8644/webhooks/reminder", secret: "a".repeat(64) },
    truncatedPeriodic: {
      route: "qqbot",
      url: "http://127.0.0.1:8644/webhooks/reminder",
      secret: "0123456789abc".repeat(5).slice(0, 64),
    },
    weak: { route: "qqbot", url: "http://localhost:8644/webhooks/reminder", secret: "short" },
    badRoute: { route: "bad route", url: "http://localhost:8644/webhooks/reminder", secret: strongA },
  }));
  assert.equal(Object.getPrototypeOf(routes), null);
  assert.deepEqual(Object.keys(routes).sort(), ["constructor", "default", "localhostRoute"]);
  assert.equal(routes["constructor"].secret, strongB);
});

test("Profile context is required and never falls back to default", () => {
  // L28：删除/恢复 HERMES_PROFILE 必须成对（try/finally），保证任何断言失败都不污染后续用例。
  const original = process.env.HERMES_PROFILE;
  delete process.env.HERMES_PROFILE;
  try {
    assert.throws(() => requireProfileContext(), /HERMES_PROFILE/);
  } finally {
    if (original === undefined) delete process.env.HERMES_PROFILE;
    else process.env.HERMES_PROFILE = original;
  }
  assert.equal(requireProfileContext().id, "profile-a");
});

test("schedule CRUD is isolated by Profile", () => {
  const a = requireProfileContext("profile-a");
  const created = createSchedule(a, {
    title: "A private anniversary",
    calendar: "solar",
    date: "2026-08-10",
    time: "09:30",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  assert.equal(listSchedules(a).length, 1);

  const b = requireProfileContext("profile-b");
  assert.equal(listSchedules(b).length, 0);
  assert.throws(() => getSchedule(b, created.id), /not found/i);
  assert.throws(() => updateSchedule(b, created.id, { title: "stolen" }), /not found/i);
  assert.throws(() => deleteSchedule(b, created.id), /not found/i);
  assert.equal(getSchedule(a, created.id).title, "A private anniversary");
});

test("global notices are visible once independently to each Profile", async () => {
  await publishGlobal({ title: "weather", body: "shared alert", dedupeKey: "global:test:1" });
  const a = pullPending(requireProfileContext("profile-a"));
  const b = pullPending(requireProfileContext("profile-b"));
  assert.equal(a.filter((n) => n.body === "shared alert").length, 1);
  assert.equal(b.filter((n) => n.body === "shared alert").length, 1);
  assert.equal(pullPending(requireProfileContext("profile-a")).some((n) => n.body === "shared alert"), false);
});

test("the two-argument global form preserves its resolved fields for every Profile", async () => {
  await publishGlobal({ title: "Two-argument title", body: "Two-argument body" });

  const rows = db.prepare(`
    SELECT profile_id, source, title, body, dedupe_key
    FROM profile_notifications
    WHERE title = ? OR body = ?
    ORDER BY profile_id
  `).all("Two-argument title", "Two-argument body") as Array<Record<string, unknown>>;

  assert.deepEqual(rows.map((row) => ({ ...row })), [
    {
      profile_id: "profile-a",
      source: "general",
      title: "Two-argument title",
      body: "Two-argument body",
      dedupe_key: null,
    },
    {
      profile_id: "profile-b",
      source: "general",
      title: "Two-argument title",
      body: "Two-argument body",
      dedupe_key: null,
    },
  ]);
});

test("a global event enqueues exactly one Hermes delivery per configured Profile route", async () => {
  await publishGlobal({ source: "weather", title: "Public alert", body: "shared active push", dedupeKey: "global:push:once" });
  await publishGlobal({ source: "weather", title: "Public alert", body: "shared active push", dedupeKey: "global:push:once" });

  const rows = db.prepare(`
    SELECT n.profile_id, n.source, n.title, n.body, d.route, d.status
    FROM profile_notifications n
    JOIN profile_notification_deliveries d
      ON d.profile_id = n.profile_id AND d.notification_id = n.id
    WHERE n.dedupe_key = ?
    ORDER BY n.profile_id
  `).all("global:push:once") as Array<Record<string, unknown>>;

  assert.deepEqual(rows.map((row) => ({ ...row })), [
    {
      profile_id: "profile-a",
      source: "weather",
      title: "Public alert",
      body: "shared active push",
      route: "qqbot",
      status: "pending",
    },
    {
      profile_id: "profile-b",
      source: "weather",
      title: "Public alert",
      body: "shared active push",
      route: "qqbot",
      status: "pending",
    },
  ]);
});

test("republishing a retained legacy global event does not create Profile duplicates", async () => {
  const dedupeKey = "global:legacy-retained:1";
  db.prepare(`
    INSERT INTO global_notifications(source, title, body, created_at, dedupe_key)
    VALUES(?, ?, ?, ?, ?)
  `).run("weather", "Legacy alert", "retained pull item", "2026-08-02T00:00:00.000Z", dedupeKey);

  await publishGlobal({ source: "weather", title: "Republished alert", body: "duplicate profile item", dedupeKey });

  const profileCopies = db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notifications WHERE dedupe_key = ?
  `).get(dedupeKey) as { count: number };
  assert.equal(profileCopies.count, 0);

  const logicalEvents = pullPending(requireProfileContext("profile-a"))
    .filter((notice) => notice.dedupeKey === dedupeKey);
  assert.equal(logicalEvents.length, 1);
  assert.equal(logicalEvents[0].scope, "global");
  assert.equal(logicalEvents[0].body, "retained pull item");
});

test("a retained global weather alert promotes an exact legacy alias without fan-out", async () => {
  const legacyKey = "weather:alert:保留的官方原始标题:2026-08-04";
  const stableKey = "weather:alert:id:retained-global-upgrade";
  const inserted = db.prepare(`
    INSERT INTO global_notifications(source, title, body, created_at, dedupe_key)
    VALUES(?, ?, ?, ?, ?)
  `).run("weather", "Legacy global title", "Legacy global body", "2026-08-04T23:58:00.000Z", legacyKey) as {
    lastInsertRowid: number | bigint;
  };

  await publishGlobal({ source: "weather", title: "New rendered title", body: "New rendered body", dedupeKey: stableKey }, { legacyDedupeKeys: [legacyKey, "weather:alert:保留的官方原始标题:2026-08-03"] });

  const row = db.prepare(`
    SELECT id, title, body, dedupe_key FROM global_notifications WHERE id = ?
  `).get(Number(inserted.lastInsertRowid)) as Record<string, unknown>;
  assert.deepEqual({ ...row }, {
    id: Number(inserted.lastInsertRowid),
    title: "Legacy global title",
    body: "Legacy global body",
    dedupe_key: stableKey,
  });
  const profileCopies = db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notifications WHERE dedupe_key = ?
  `).get(stableKey) as { count: number };
  assert.equal(profileCopies.count, 0);
});

test("an existing stable key wins without deleting its legacy alias row", async () => {
  const globalLegacyKey = "weather:alert:global-conflict-title:2026-08-04";
  const globalStableKey = "weather:alert:id:global-conflict";
  db.prepare(`
    INSERT INTO global_notifications(source, title, body, created_at, dedupe_key)
    VALUES('weather', 'Global legacy', 'Global legacy body', ?, ?),
          ('weather', 'Global stable', 'Global stable body', ?, ?)
  `).run(
    "2026-08-04T00:00:00.000Z",
    globalLegacyKey,
    "2026-08-04T01:00:00.000Z",
    globalStableKey,
  );

  await publishGlobal({ source: "weather", title: "Ignored replacement", body: "Ignored replacement body", dedupeKey: globalStableKey }, { legacyDedupeKeys: [globalLegacyKey] });

  const globalRows = db.prepare(`
    SELECT title, dedupe_key FROM global_notifications
    WHERE dedupe_key IN (?, ?) ORDER BY dedupe_key
  `).all(globalStableKey, globalLegacyKey) as Array<Record<string, unknown>>;
  assert.deepEqual(globalRows.map((row) => ({ ...row })), [
    { title: "Global legacy", dedupe_key: globalLegacyKey },
    { title: "Global stable", dedupe_key: globalStableKey },
  ]);

  const profileLegacyKey = "weather:alert:profile-conflict-title:2026-08-04";
  const profileStableKey = "weather:alert:id:profile-conflict";
  await publishProfile({ profileId: "profile-a", source: "weather", title: "Profile legacy", body: "Legacy body", dedupeKey: profileLegacyKey });
  await publishProfile({ profileId: "profile-a", source: "weather", title: "Profile stable", body: "Stable body", dedupeKey: profileStableKey });
  await publishProfile({ profileId: "profile-a", source: "weather", title: "Ignored replacement", body: "Ignored replacement body", dedupeKey: profileStableKey }, { legacyDedupeKeys: [profileLegacyKey] });

  const profileRows = db.prepare(`
    SELECT title, dedupe_key FROM profile_notifications
    WHERE profile_id = ? AND dedupe_key IN (?, ?) ORDER BY dedupe_key
  `).all("profile-a", profileStableKey, profileLegacyKey) as Array<Record<string, unknown>>;
  assert.deepEqual(profileRows.map((row) => ({ ...row })), [
    { title: "Profile stable", dedupe_key: profileStableKey },
    { title: "Profile legacy", dedupe_key: profileLegacyKey },
  ]);
});

test("the deterministic daily brief publishes once per local date through every Profile route", async () => {
  assert.equal(typeof runDailyWeatherBrief, "function");
  let oilProviderCalls = 0;
  const options = {
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "北京", lat: 39.9, lon: 116.4 }),
    getAirQuality: async () => { throw new Error("aqi provider unavailable"); },
    getCurrent: async () => ({
      temperature: 28,
      apparent: 30,
      humidity: 61,
      windSpeed: 12,
      windSpeedUnit: "km/h" as const,
      weatherText: "多云",
    }),
    getForecast: async () => [{
      date: "2026-08-03",
      tMax: 32,
      tMin: 24,
      weatherText: "阵雨",
      precipProb: 70,
    }],
    getOilPrice: async () => {
      oilProviderCalls += 1;
      return { region: "北京", p92: "7.21", p95: "7.68", p0: "6.91" };
    },
  };

  await runDailyWeatherBrief({ ...options, at: new Date("2026-08-03T00:00:00.000Z") });
  await runDailyWeatherBrief({ ...options, at: new Date("2026-08-03T10:00:00.000Z") });

  // 天气模块已改为按城市区分 daily-brief 键（weather:daily-brief:{city}:{localDate}）。
  const sameDay = db.prepare(`
    SELECT profile_id, title, body FROM profile_notifications
    WHERE dedupe_key = ? ORDER BY profile_id
  `).all("weather:daily-brief:北京:2026-08-03") as Array<Record<string, unknown>>;
  assert.equal(sameDay.length, 2);
  assert.deepEqual(sameDay.map((row) => row.profile_id), ["profile-a", "profile-b"]);
  assert.equal(sameDay[0].title, "北京今天阵雨，24～32℃，注意带伞");
  assert.equal(sameDay[0].body, [
    "当前：多云，28℃，体感30℃，湿度61%",
    "今日：24～32℃，阵雨",
    "降水：最高概率70%",
    "建议：外出记得带伞",
  ].join("\n"));
  assert.doesNotMatch(String(sameDay[0].body), /油价|92#|95#|0#/);
  assert.doesNotMatch(String(sameDay[0].body), /\|/);

  await runDailyWeatherBrief({ ...options, at: new Date("2026-08-04T00:00:00.000Z") });
  const allBriefs = db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notifications
    WHERE dedupe_key LIKE 'weather:daily-brief:%'
  `).get() as { count: number };
  assert.equal(allBriefs.count, 4);
  assert.equal(oilProviderCalls, 0);
});

test("the daily brief labels probability percent and precipitation amount millimeters distinctly", async () => {
  const bodies: string[] = [];
  const common = {
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "北京", lat: 39.9, lon: 116.4 }),
    getAirQuality: async () => { throw new Error("aqi provider unavailable"); },
    getCurrent: async () => { throw new Error("current unavailable"); },
    publish: async ({ body }) => {
      bodies.push(body);
    },
  };

  await runDailyWeatherBrief({
    ...common,
    at: new Date("2026-08-07T00:00:00.000Z"),
    getForecast: async () => [{
      date: "2026-08-07",
      tMax: 30,
      tMin: 23,
      weatherText: "阵雨",
      precipProb: 65,
    }],
  });
  await runDailyWeatherBrief({
    ...common,
    at: new Date("2026-08-08T00:00:00.000Z"),
    getForecast: async () => [{
      date: "2026-08-08",
      tMax: 29,
      tMin: 22,
      weatherText: "中雨",
      precipAmountMm: 12.7,
    }],
  });

  assert.match(bodies[0], /今日：23～30℃，阵雨\n降水：最高概率65%/);
  assert.doesNotMatch(bodies[0], /预计降水/);
  assert.match(bodies[1], /今日：22～29℃，中雨\n降水：预计12\.7mm/);
  assert.doesNotMatch(bodies[1], /降水概率|undefined%/);
});

test("the daily brief survives a forecast provider failure", async () => {
  const published: Array<{ source: string; title: string; body: string; dedupeKey: string }> = [];
  await runDailyWeatherBrief({
    at: new Date("2026-08-05T00:00:00.000Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "上海", lat: 31.2, lon: 121.5 }),
    getAirQuality: async () => { throw new Error("aqi provider unavailable"); },
    getCurrent: async () => ({
      temperature: 30,
      apparent: 33,
      humidity: 70,
      windSpeed: 8,
      windSpeedUnit: "km/h",
      weatherText: "晴",
    }),
    getForecast: async () => { throw new Error("forecast unavailable"); },
    publish: async ({ source, title, body, dedupeKey }) => {
      published.push({ source, title, body, dedupeKey });
    },
  });

  assert.deepEqual(published, [{
    source: "weather",
    title: "上海当前晴，30℃",
    body: "当前：晴，30℃，体感33℃，湿度70%",
    // 天气模块的 daily-brief 键已按城市区分（weather:daily-brief:{city}:{localDate}）。
    dedupeKey: "weather:daily-brief:上海:2026-08-05",
  }]);
});

test("the daily brief leaves its dedupe key free when current weather fails and forecast is empty", async () => {
  const published: Array<{ source: string; title: string; body: string; dedupeKey: string }> = [];
  let currentAttempt = 0;
  const options = {
    at: new Date("2026-08-06T00:00:00.000Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "广州", lat: 23.1, lon: 113.3 }),
    getCurrent: async () => {
      currentAttempt += 1;
      if (currentAttempt === 1) throw new Error("current unavailable");
      return {
        temperature: 31,
        apparent: 35,
        humidity: 76,
        windSpeed: 9,
        windSpeedUnit: "km/h" as const,
        weatherText: "多云",
      };
    },
    getForecast: async () => [],
    publish: async ({ source, title, body, dedupeKey }) => {
      published.push({ source, title, body, dedupeKey });
    },
  };

  await assert.rejects(() => runDailyWeatherBrief(options), /daily weather brief providers failed/);
  assert.deepEqual(published, []);

  await runDailyWeatherBrief(options);
  assert.equal(published.length, 1);
  // 天气模块的 daily-brief 键已按城市区分（weather:daily-brief:{city}:{localDate}）。
  assert.equal(published[0].dedupeKey, "weather:daily-brief:广州:2026-08-06");
  assert.match(published[0].body, /当前：多云，31℃/);
});

test("an official alert ID publishes one weather event through every Profile route", async () => {
  assert.equal(typeof runWeatherAlertsCheck, "function");
  const alert: WeatherAlert = {
    kind: "official",
    id: "integration-provider-id-1",
    publisher: "江西省气象台",
    issuedAt: "2026-08-04T06:11Z",
    eventType: "雷电",
    eventCode: "1014",
    level: "橙色",
    severity: "severe",
    effectiveAt: "2026-08-04T06:11Z",
    onsetAt: "2026-08-04T06:11Z",
    expiresAt: "2026-08-04T11:11Z",
    headline: "官方标题原文",
    description: "官方完整原文。",
    criteria: "雷电灾害事故发生可能性较大。",
    instruction: "密切关注天气，尽量避免户外活动。",
    attributions: ["国家预警信息发布中心"],
  };
  const options = {
    at: new Date("2026-08-04T11:30:00Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "萍乡", lat: 27.62, lon: 113.85 }),
    getAlerts: async () => [alert],
  };

  await runWeatherAlertsCheck(options);
  await runWeatherAlertsCheck(options);

  const rows = db.prepare(`
    SELECT profile_id, source, title, body FROM profile_notifications
    WHERE dedupe_key = ? ORDER BY profile_id
  `).all("weather:alert:id:integration-provider-id-1") as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.profile_id), ["profile-a", "profile-b"]);
  assert.ok(rows.every((row) => row.source === "weather"));
  assert.ok(rows.every((row) => row.title === "雷电橙色预警：雷电灾害事故发生可能性较大。"));
  assert.match(String(rows[0].body), /^时间：.*\n风险：.*\n建议：.*\n来源：.*\n\n官方原文：\n官方完整原文。$/);
  assert.doesNotMatch(String(rows[0].body), /区域：|undefined/);
});

test("official alert publish failure is isolated so the remaining alerts still publish", async () => {
  const base = {
    publisher: "江西省气象台",
    issuedAt: "2026-08-04T06:11Z",
    attributions: ["国家预警信息发布中心"],
  };
  const alertA: WeatherAlert = {
    kind: "official",
    id: "isolation-provider-id-1",
    eventType: "雷电",
    level: "橙色",
    headline: "隔离测试第一条官方标题",
    description: "第一条官方完整原文。",
    ...base,
  };
  const alertB: WeatherAlert = {
    kind: "official",
    id: "isolation-provider-id-2",
    eventType: "大风",
    level: "蓝色",
    headline: "隔离测试第二条官方标题",
    description: "第二条官方完整原文。",
    ...base,
  };
  const published: string[] = [];
  let calls = 0;
  await runWeatherAlertsCheck({
    at: new Date("2026-08-04T11:30:00Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "萍乡", lat: 27.62, lon: 113.85 }),
    getAlerts: async () => [alertA, alertB],
    publish: async ({ dedupeKey }: { dedupeKey?: string }) => {
      calls += 1;
      if (calls === 1) throw new Error("simulated transient publish failure");
      if (dedupeKey) published.push(dedupeKey);
    },
  });
  // 第一条发布抛错被逐条隔离，第二条照常发布；本条用例注入 publish，不产生 DB 行。
  assert.equal(calls, 2);
  assert.deepEqual(published, ["weather:alert:id:isolation-provider-id-2"]);
});

test("an official alert upgrades an exact legacy Profile key without resending", async () => {
  const alert: WeatherAlert = {
    kind: "official",
    id: "upgrade-provider-id-1",
    publisher: "江西省气象台",
    issuedAt: "2026-08-04T23:45Z",
    eventType: "暴雨",
    level: "橙色",
    headline: "跨 UTC 午夜的官方原始标题",
    description: "新版官方完整原文。",
    criteria: "短时强降雨风险较高。",
    instruction: "注意防范城乡积涝。",
    attributions: ["国家预警信息发布中心"],
  };
  const legacyKey = "weather:alert:跨 UTC 午夜的官方原始标题:2026-08-04";
  const stableKey = "weather:alert:id:upgrade-provider-id-1";
  const createdAt = "2026-08-04T23:55:00.000Z";
  const inserted = db.prepare(`
    INSERT INTO profile_notifications(profile_id, source, title, body, created_at, dedupe_key)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run("profile-a", "weather", "Legacy profile title", "Legacy profile body", createdAt, legacyKey) as {
    lastInsertRowid: number | bigint;
  };
  const legacyNotificationId = Number(inserted.lastInsertRowid);
  db.prepare(`
    INSERT INTO profile_notification_deliveries(
      profile_id, notification_id, route, status, attempts,
      next_attempt_at, sent_at, created_at, updated_at
    ) VALUES(?, ?, 'qqbot', 'sent', 3, ?, ?, ?, ?)
  `).run("profile-a", legacyNotificationId, createdAt, createdAt, createdAt, createdAt);
  const options = {
    at: new Date("2026-08-05T00:03:00.000Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "萍乡", lat: 27.62, lon: 113.85 }),
    getAlerts: async () => [alert],
  };

  await runWeatherAlertsCheck(options);

  const profileA = db.prepare(`
    SELECT id, title, body, created_at, dedupe_key
    FROM profile_notifications WHERE profile_id = ? AND id = ?
  `).get("profile-a", legacyNotificationId) as Record<string, unknown>;
  assert.deepEqual({ ...profileA }, {
    id: legacyNotificationId,
    title: "Legacy profile title",
    body: "Legacy profile body",
    created_at: createdAt,
    dedupe_key: stableKey,
  });
  const profileADelivery = db.prepare(`
    SELECT status, attempts FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ?
  `).get("profile-a", legacyNotificationId) as Record<string, unknown>;
  assert.deepEqual({ ...profileADelivery }, { status: "sent", attempts: 3 });

  const profileB = db.prepare(`
    SELECT n.id, n.dedupe_key, d.status, d.attempts
    FROM profile_notifications n
    JOIN profile_notification_deliveries d
      ON d.profile_id = n.profile_id AND d.notification_id = n.id
    WHERE n.profile_id = ? AND n.dedupe_key = ?
  `).get("profile-b", stableKey) as Record<string, unknown>;
  assert.equal(profileB.dedupe_key, stableKey);
  assert.equal(profileB.status, "pending");
  assert.equal(profileB.attempts, 0);

  await runWeatherAlertsCheck(options);

  const counts = db.prepare(`
    SELECT profile_id, COUNT(*) AS count
    FROM profile_notifications
    WHERE dedupe_key IN (?, ?)
    GROUP BY profile_id ORDER BY profile_id
  `).all(stableKey, legacyKey) as Array<Record<string, unknown>>;
  assert.deepEqual(counts.map((row) => ({ ...row })), [
    { profile_id: "profile-a", count: 1 },
    { profile_id: "profile-b", count: 1 },
  ]);
  const unchangedDelivery = db.prepare(`
    SELECT status, attempts FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ?
  `).get("profile-a", legacyNotificationId) as Record<string, unknown>;
  assert.deepEqual({ ...unchangedDelivery }, { status: "sent", attempts: 3 });
});

test("an inferred weather risk is explicitly labeled and never rendered as an official alert", async () => {
  const published: Array<{ source: string; title: string; body: string; dedupeKey: string }> = [];
  await runWeatherAlertsCheck({
    at: new Date("2026-08-04T11:30:00Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "萍乡", lat: 27.62, lon: 113.85 }),
    getAlerts: async () => [{
      kind: "inferred",
      title: "萍乡高温推断提醒",
      level: "inferred",
      description: "未来48小时最高气温约36℃，注意防暑降温。",
    }],
    publish: async ({ source, title, body, dedupeKey }) => {
      published.push({ source, title, body, dedupeKey });
    },
  });

  assert.deepEqual(published, [{
    source: "weather",
    title: "系统推断风险：萍乡高温推断提醒",
    body: "未来48小时最高气温约36℃，注意防暑降温。",
    dedupeKey: "weather:inferred:%E8%90%8D%E4%B9%A1%E9%AB%98%E6%B8%A9%E6%8E%A8%E6%96%AD%E6%8F%90%E9%86%92:2026-08-04",
  }]);
  assert.doesNotMatch(published[0].title + published[0].body, /官方预警|官方原文/);
});

test("fallback alert identity dedupes repeats but treats a new issued time as a new event", async () => {
  const baseAlert: WeatherAlert = {
    kind: "official",
    publisher: "fallback-integration气象台",
    issuedAt: "2026-08-04T06:11Z",
    eventType: "雷电",
    level: "黄色",
    severity: "moderate",
    headline: "官方标题原文",
    description: "第一份官方完整原文。",
    attributions: ["国家预警信息发布中心"],
  };
  const common = {
    at: new Date("2026-08-04T11:30:00Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "萍乡", lat: 27.62, lon: 113.85 }),
  };

  await runWeatherAlertsCheck({ ...common, getAlerts: async () => [baseAlert] });
  await runWeatherAlertsCheck({ ...common, getAlerts: async () => [baseAlert] });
  await runWeatherAlertsCheck({
    ...common,
    getAlerts: async () => [{
      ...baseAlert,
      issuedAt: "2026-08-04T07:11Z",
      description: "发布时间变化后的官方完整原文。",
    }],
  });

  const rows = db.prepare(`
    SELECT profile_id, source, dedupe_key FROM profile_notifications
    WHERE dedupe_key LIKE 'weather:alert:fallback:fallback-integration%'
    ORDER BY dedupe_key, profile_id
  `).all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.dedupe_key)).size, 2);
  assert.ok(rows.every((row) => row.source === "weather"));
  assert.deepEqual(rows.map((row) => row.profile_id), ["profile-a", "profile-b", "profile-a", "profile-b"]);
});

test("an alert without a usable identity is omitted without blocking later official alerts", async () => {
  const published: Array<{ dedupeKey: string }> = [];
  await runWeatherAlertsCheck({
    at: new Date("2026-08-04T11:30:00Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "萍乡", lat: 27.62, lon: 113.85 }),
    getAlerts: async () => [{
      kind: "official",
      eventType: "雷电",
      headline: "字段不完整的官方标题",
      description: "字段不完整的官方原文。",
      attributions: [],
    }, {
      kind: "official",
      id: "valid-after-incomplete",
      publisher: "萍乡市气象台",
      issuedAt: "2026-08-04T10:11Z",
      eventType: "大风",
      level: "蓝色",
      headline: "完整的官方标题",
      description: "完整的官方原文。",
      attributions: [],
    }],
    publish: async ({ dedupeKey }) => {
      published.push({ dedupeKey });
    },
  });

  assert.deepEqual(published, [{ dedupeKey: "weather:alert:id:valid-after-incomplete" }]);
});

test("the standard scheduler notify callback automatically uses Profile Hermes routes", async () => {
  await notify("Future module notice", "standard callback body", "future:standard-notify:1");
  const rows = db.prepare(`
    SELECT n.profile_id, d.route, d.status
    FROM profile_notifications n
    JOIN profile_notification_deliveries d
      ON d.profile_id = n.profile_id AND d.notification_id = n.id
    WHERE n.dedupe_key = ? ORDER BY n.profile_id
  `).all("future:standard-notify:1") as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { profile_id: "profile-a", route: "qqbot", status: "pending" },
    { profile_id: "profile-b", route: "qqbot", status: "pending" },
  ]);
});

test("profile notices never cross the queue boundary", async () => {
  await publishProfile({ profileId: "profile-a", title: "schedule", body: "A only", dedupeKey: "profile:test:a" });
  const a = pullPending(requireProfileContext("profile-a"));
  const b = pullPending(requireProfileContext("profile-b"));
  assert.equal(a.some((n) => n.body === "A only"), true);
  assert.equal(b.some((n) => n.body === "A only"), false);
});

test("a Profile notification with no configured route remains in notify.pull", async () => {
  await publishProfile({ profileId: "profile-c", source: "schedule", title: "No route", body: "pull fallback", dedupeKey: "profile:missing-route:1" });
  const notices = pullPending(requireProfileContext("profile-c"));
  assert.equal(notices.some((notice) => notice.title === "No route" && notice.body === "pull fallback"), true);
  const deliveries = db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.profile_id = d.profile_id AND n.id = d.notification_id
    WHERE n.profile_id = ? AND n.dedupe_key = ?
  `).get("profile-c", "profile:missing-route:1") as { count: number };
  assert.equal(deliveries.count, 0);
});

test("configured profiles enqueue one idempotent QQ webhook delivery", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "QQ push", body: "private body", dedupeKey: "push:test:a" });
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "QQ push", body: "private body", dedupeKey: "push:test:a" });
  await publishProfile({ profileId: "profile-c", source: "schedule", title: "queue only", body: "fallback body", dedupeKey: "push:test:c" });

  const rows = db.prepare(`
    SELECT d.profile_id, d.route, d.status, n.title
    FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE n.dedupe_key IN (?, ?)
    ORDER BY d.profile_id
  `).all("push:test:a", "push:test:c") as Array<Record<string, unknown>>;

  assert.deepEqual(rows.map((row) => ({ ...row })), [{
    profile_id: "profile-a",
    route: "qqbot",
    status: "pending",
    title: "QQ push",
  }]);
});

test("a route change never re-enqueues a notification that was already sent", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Delivered before route change", body: "do not resend", dedupeKey: "push:sent-before-route-change" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:sent-before-route-change") as { id: number };
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'sent', sent_at = ?
    WHERE profile_id = ? AND notification_id = ? AND route = 'qqbot'
  `).run(new Date().toISOString(), "profile-a", notification.id);
  const routes = (configModule.config as { profilePushRoutes: Record<string, { route: string; url: string; secret: string }> }).profilePushRoutes;
  const original = routes["profile-a"];
  routes["profile-a"] = {
    route: "new-qq-route",
    url: "http://127.0.0.1:8644/webhooks/life-assistant-reminder-v2",
    secret: testSecretA,
  };
  try {
    await publishProfile({ profileId: "profile-a", source: "schedule", title: "Delivered before route change", body: "do not resend", dedupeKey: "push:sent-before-route-change" });
  } finally {
    routes["profile-a"] = original;
  }
  const deliveries = db.prepare(`
    SELECT route, status FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ? ORDER BY route
  `).all("profile-a", notification.id) as Array<Record<string, unknown>>;
  assert.deepEqual(deliveries.map((row) => ({ ...row })), [{ route: "qqbot", status: "sent" }]);
});

test("removed routes do not consume delivery batch capacity", async () => {
  // L30：只取消本用例命名空间（push:removed-route:* / push:valid-after-stale）之外的既有
  // deliveries，不再无条件清全表；本用例自己的行在下方发布后才产生，语义与旧行为一致。
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications
      WHERE dedupe_key LIKE 'push:removed-route:%' OR dedupe_key = 'push:valid-after-stale'
    )
  `).run();
  for (let index = 0; index < 101; index += 1) {
    await publishProfile({ profileId: "profile-a", source: "schedule", title: `Removed route ${index}`, body: "stale route", dedupeKey: `push:removed-route:${index}` });
  }
  db.prepare(`
    UPDATE profile_notification_deliveries
    SET route = 'removed-route', next_attempt_at = '2000-01-01T00:00:00.000Z'
    WHERE notification_id IN (
      SELECT id FROM profile_notifications WHERE dedupe_key LIKE 'push:removed-route:%'
    )
  `).run();
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Valid after stale batch", body: "must send", dedupeKey: "push:valid-after-stale" });

  let calls = 0;
  const result = await deliverPendingProfileNotifications({
    at: new Date("2100-01-01T00:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: (async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
    clock: () => new Date("2100-01-01T00:00:00.000Z"),
  });
  const fallback = db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notification_deliveries
    WHERE route = 'removed-route' AND status = 'fallback'
  `).get() as { count: number };
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(calls, 1);
  assert.equal(fallback.count, 101);
});

test("QQ webhook delivery uses HMAC V2 and marks the outbox sent", async () => {
  await publishProfile({ profileId: "profile-b", source: "schedule", title: "Deliver me", body: "private body", dedupeKey: "push:deliver:b" });
  const at = new Date("2100-01-01T00:00:00.000Z");
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ status: "delivered" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  assert.equal(typeof deliverPendingProfileNotifications, "function");
  const summary = await deliverPendingProfileNotifications({ at, profileId: "profile-b", fetchImpl, clock: () => at });
  assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:8645/webhooks/life-assistant-reminder");
  // 与 src/core/notifier.ts 当前实现一致：重定向按 manual 处理（N8：3xx 视为已确认失败）。
  assert.equal(requests[0].init.redirect, "manual");
  assert.ok(requests[0].init.signal instanceof AbortSignal);

  const headers = new Headers(requests[0].init.headers);
  const body = String(requests[0].init.body);
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const expectedSignature = crypto.createHmac("sha256", testSecretB)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  assert.equal(headers.get("X-Webhook-Timestamp"), timestamp);
  assert.equal(headers.get("X-Webhook-Signature-V2"), expectedSignature);
  assert.match(headers.get("X-Request-ID") ?? "", /^life-assistant:profile-b:\d+:qqbot:a1$/);

  const row = db.prepare(`
    SELECT d.status, d.attempts, d.sent_at
    FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE n.dedupe_key = ?
  `).get("push:deliver:b") as Record<string, unknown>;
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 1);
  assert.ok(row.sent_at);
  const reads = db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notification_reads r
    JOIN profile_notifications n ON n.id = r.notification_id AND n.profile_id = r.profile_id
    WHERE n.dedupe_key = ?
  `).get("push:deliver:b") as { count: number };
  assert.equal(reads.count, 1);
});

test("each webhook request uses a fresh HMAC timestamp", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Batch one", body: "body one", dedupeKey: "push:batch:1" });
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Batch two", body: "body two", dedupeKey: "push:batch:2" });
  // L30：投递隔离改按本用例 dedupe_key 定向保留（其余历史 deliveries 取消），不再依赖裸 id 宽扫。
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key IN (?, ?)
    )
  `).run("profile-a", "push:batch:1", "push:batch:2");
  const clockValues = [
    new Date("2100-01-02T00:00:00.000Z"),
    new Date("2100-01-02T00:05:01.000Z"),
  ];
  const expectedTimestamps = clockValues.map((value) => String(Math.floor(value.getTime() / 1000)));
  const timestamps: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    timestamps.push(new Headers(init?.headers).get("X-Webhook-Timestamp") ?? "");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const summary = await deliverPendingProfileNotifications({
    at: new Date("2100-01-02T00:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl,
    clock: () => clockValues.shift() ?? new Date("2100-01-02T00:05:01.000Z"),
  });
  assert.deepEqual(summary, { attempted: 2, sent: 2, failed: 0 });
  assert.deepEqual(timestamps, expectedTimestamps);
});

test("failed QQ delivery waits for backoff before retrying", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Retry me", body: "retry body", dedupeKey: "push:retry:a" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:retry:a") as { id: number };
  // L30：按本用例 dedupe_key 定向隔离，不再用 (profile_id, notification_id) 反选宽扫。
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-a", "push:retry:a");

  const firstAt = new Date("2100-02-01T00:00:00.000Z");
  let calls = 0;
  const requestIds: string[] = [];
  const failingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    requestIds.push(new Headers(init?.headers).get("X-Request-ID") ?? "");
    return new Response("failed", { status: 502 });
  }) as typeof fetch;
  const failed = await deliverPendingProfileNotifications({ at: firstAt, profileId: "profile-a", fetchImpl: failingFetch, clock: () => firstAt });
  assert.deepEqual(failed, { attempted: 1, sent: 0, failed: 1 });

  const afterFailure = db.prepare(`
    SELECT status, attempts, next_attempt_at
    FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ? AND route = ?
  `).get("profile-a", notification.id, "qqbot") as Record<string, unknown>;
  assert.equal(afterFailure.status, "failed");
  assert.equal(afterFailure.attempts, 1);
  assert.equal(afterFailure.next_attempt_at, "2100-02-01T00:01:00.000Z");

  const tooEarly = await deliverPendingProfileNotifications({
    at: new Date("2100-02-01T00:00:30.000Z"),
    profileId: "profile-a",
    fetchImpl: failingFetch,
    clock: () => new Date("2100-02-01T00:00:30.000Z"),
  });
  assert.deepEqual(tooEarly, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(calls, 1);

  const successFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestIds.push(new Headers(init?.headers).get("X-Request-ID") ?? "");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const recovered = await deliverPendingProfileNotifications({
    at: new Date("2100-02-01T00:01:01.000Z"),
    profileId: "profile-a",
    fetchImpl: successFetch,
    clock: () => new Date("2100-02-01T00:01:01.000Z"),
  });
  assert.deepEqual(recovered, { attempted: 1, sent: 1, failed: 0 });
  const finalRow = db.prepare(`
    SELECT status, attempts FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ? AND route = ?
  `).get("profile-a", notification.id, "qqbot") as Record<string, unknown>;
  assert.equal(finalRow.status, "sent");
  assert.equal(finalRow.attempts, 2);
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
});

test("confirmed HTTP failures may retry a fresh request ID after a one-hour backoff", async () => {
  await publishProfile({ profileId: "profile-b", source: "schedule", title: "HTTP retry", body: "fresh generation", dedupeKey: "push:http-long-retry:b" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:http-long-retry:b") as { id: number };
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-b", "push:http-long-retry:b");
  const requestIds: string[] = [];
  const failingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestIds.push(new Headers(init?.headers).get("X-Request-ID") ?? "");
    return new Response("unavailable", { status: 502 });
  }) as typeof fetch;
  const failureTimes = [
    new Date("2100-02-06T00:00:00.000Z"),
    new Date("2100-02-06T00:01:01.000Z"),
    new Date("2100-02-06T00:06:02.000Z"),
    new Date("2100-02-06T00:21:03.000Z"),
  ];
  for (const at of failureTimes) {
    await deliverPendingProfileNotifications({ at, profileId: "profile-b", fetchImpl: failingFetch, clock: () => at });
  }
  const recoveryAt = new Date("2100-02-06T01:21:04.000Z");
  const recovered = await deliverPendingProfileNotifications({
    at: recoveryAt,
    profileId: "profile-b",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      requestIds.push(new Headers(init?.headers).get("X-Request-ID") ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
    clock: () => recoveryAt,
  });
  const row = db.prepare(`
    SELECT status, attempts FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ?
  `).get("profile-b", notification.id) as Record<string, unknown>;
  assert.deepEqual(recovered, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(row.status, "sent");
  assert.equal(row.attempts, 5);
  assert.equal(new Set(requestIds).size, 5);
});

test("confirmed HTTP failures stop after the bounded retry schedule and remain pullable", async () => {
  await publishProfile({ profileId: "profile-b", source: "schedule", title: "Bounded HTTP failure", body: "recover by pull", dedupeKey: "push:http-bounded:b" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:http-bounded:b") as { id: number };
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-b", "push:http-bounded:b");
  const failingFetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  const attempts = [
    new Date("2100-02-07T00:00:00.000Z"),
    new Date("2100-02-07T00:01:01.000Z"),
    new Date("2100-02-07T00:06:02.000Z"),
    new Date("2100-02-07T00:21:03.000Z"),
    new Date("2100-02-07T01:21:04.000Z"),
  ];
  for (const at of attempts) {
    await deliverPendingProfileNotifications({ at, profileId: "profile-b", fetchImpl: failingFetch, clock: () => at });
  }

  const row = db.prepare(`
    SELECT status, attempts FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ?
  `).get("profile-b", notification.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { status: "fallback", attempts: 5 });
  const pulled = pullPending(requireProfileContext("profile-b"));
  assert.equal(pulled.some((notice) => notice.title === "Bounded HTTP failure"), true);
});

test("a transport timeout reuses the same webhook request ID", async () => {
  await publishProfile({ profileId: "profile-b", source: "schedule", title: "Timeout me", body: "network uncertain", dedupeKey: "push:timeout:b" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:timeout:b") as { id: number };
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-b", "push:timeout:b");

  const requestIds: string[] = [];
  const timeoutFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestIds.push(new Headers(init?.headers).get("X-Request-ID") ?? "");
    throw new TypeError("network timeout");
  }) as typeof fetch;
  await deliverPendingProfileNotifications({
    at: new Date("2100-02-02T00:00:00.000Z"),
    profileId: "profile-b",
    fetchImpl: timeoutFetch,
    clock: () => new Date("2100-02-02T00:00:00.000Z"),
  });

  const successFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestIds.push(new Headers(init?.headers).get("X-Request-ID") ?? "");
    return new Response("duplicate or delivered", { status: 200 });
  }) as typeof fetch;
  await deliverPendingProfileNotifications({
    at: new Date("2100-02-02T00:01:01.000Z"),
    profileId: "profile-b",
    fetchImpl: successFetch,
    clock: () => new Date("2100-02-02T00:01:01.000Z"),
  });
  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1]);
});

test("three transport-uncertain failures fall back before the idempotency window expires", async () => {
  await publishProfile({ profileId: "profile-b", source: "schedule", title: "Fallback me", body: "avoid late duplicate", dedupeKey: "push:fallback:b" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:fallback:b") as { id: number };
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-b", "push:fallback:b");
  const requestIds: string[] = [];
  const timeoutFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestIds.push(new Headers(init?.headers).get("X-Request-ID") ?? "");
    throw new TypeError("network timeout");
  }) as typeof fetch;
  const times = [
    new Date("2100-02-04T00:00:00.000Z"),
    new Date("2100-02-04T00:01:01.000Z"),
    new Date("2100-02-04T00:06:02.000Z"),
  ];
  for (const at of times) {
    await deliverPendingProfileNotifications({ at, profileId: "profile-b", fetchImpl: timeoutFetch, clock: () => at });
  }
  const row = db.prepare(`
    SELECT status, attempts, transport_failures FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ? AND route = ?
  `).get("profile-b", notification.id, "qqbot") as Record<string, unknown>;
  assert.equal(row.status, "fallback");
  assert.equal(row.attempts, 3);
  assert.equal(row.transport_failures, 3);
  assert.equal(new Set(requestIds).size, 1);

  let lateCalls = 0;
  const late = await deliverPendingProfileNotifications({
    at: new Date("2100-02-04T02:00:00.000Z"),
    profileId: "profile-b",
    fetchImpl: (async () => {
      lateCalls += 1;
      return new Response("late", { status: 200 });
    }) as typeof fetch,
    clock: () => new Date("2100-02-04T02:00:00.000Z"),
  });
  assert.deepEqual(late, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(lateCalls, 0);
});

test("repeated stale claims cannot extend a request ID beyond the idempotency window", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Old request", body: "must fall back", dedupeKey: "push:old-request:a" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:old-request:a") as { id: number };
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-a", "push:old-request:a");
  db.prepare(`
    UPDATE profile_notification_deliveries
    SET status = 'sending', request_started_at = ?, claimed_at = ?, claim_token = ?
    WHERE profile_id = ? AND notification_id = ?
  `).run(
    "2100-02-05T00:00:00.000Z",
    "2100-02-05T00:53:00.000Z",
    "stale-worker",
    "profile-a",
    notification.id,
  );

  let calls = 0;
  const summary = await deliverPendingProfileNotifications({
    at: new Date("2100-02-05T00:56:00.000Z"),
    profileId: "profile-a",
    fetchImpl: (async () => {
      calls += 1;
      return new Response("late", { status: 200 });
    }) as typeof fetch,
    clock: () => new Date("2100-02-05T00:56:00.000Z"),
  });
  const row = db.prepare(`
    SELECT status FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ?
  `).get("profile-a", notification.id) as Record<string, unknown>;
  assert.deepEqual(summary, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(calls, 0);
  assert.equal(row.status, "fallback");
});

test("an in-flight delivery is atomically claimed from other workers and notify.pull", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Claim me", body: "single sender", dedupeKey: "push:claim:a" });
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-a", "push:claim:a");

  let releaseFetch!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  let firstCalls = 0;
  const slowFetch = (async () => {
    firstCalls += 1;
    markStarted();
    await gate;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const first = deliverPendingProfileNotifications({
    at: new Date("2100-02-03T00:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: slowFetch,
    clock: () => new Date("2100-02-03T00:00:00.000Z"),
  });
  await started;

  let duplicateCalls = 0;
  const second = await deliverPendingProfileNotifications({
    at: new Date("2100-02-03T00:00:01.000Z"),
    profileId: "profile-a",
    fetchImpl: (async () => {
      duplicateCalls += 1;
      return new Response("duplicate", { status: 200 });
    }) as typeof fetch,
    clock: () => new Date("2100-02-03T00:00:01.000Z"),
  });
  const pulled = pullPending(requireProfileContext("profile-a"));
  assert.deepEqual(second, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(duplicateCalls, 0);
  assert.equal(pulled.some((notice) => notice.title === "Claim me"), false);

  releaseFetch();
  const firstResult = await first;
  assert.deepEqual(firstResult, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(firstCalls, 1);
});

test("a successfully pushed notification is not repeated by notify.pull", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Already pushed", body: "do not repeat", dedupeKey: "push:sent:a" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:sent:a") as { id: number };
  db.prepare(`
    UPDATE profile_notification_deliveries
    SET status = 'sent', sent_at = ?, updated_at = ?
    WHERE profile_id = ? AND notification_id = ?
  `).run(new Date().toISOString(), new Date().toISOString(), "profile-a", notification.id);

  const notices = pullPending(requireProfileContext("profile-a"));
  assert.equal(notices.some((notice) => notice.title === "Already pushed"), false);
});

test("notify.pull suppression follows only the current Profile route", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Current route pending", body: "show once", dedupeKey: "push:route-change:a" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:route-change:a") as { id: number };
  // L30：按本用例 dedupe_key 定向隔离，替代旧的 notification_id <> ? 反选宽扫。
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-a", "push:route-change:a");
  const time = new Date().toISOString();
  db.prepare(`
    INSERT INTO profile_notification_deliveries(
      profile_id, notification_id, route, status, attempts,
      next_attempt_at, sent_at, created_at, updated_at
    ) VALUES(?, ?, 'old-qq-route', 'sent', 1, ?, ?, ?, ?)
  `).run("profile-a", notification.id, time, time, time, time);

  const notices = pullPending(requireProfileContext("profile-a"));
  assert.equal(notices.filter((notice) => notice.title === "Current route pending").length, 1);
  const current = db.prepare(`
    SELECT status FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ? AND route = 'qqbot'
  `).get("profile-a", notification.id) as Record<string, unknown>;
  assert.equal(current.status, "cancelled");
});

test("notify.pull ignores historical sent routes when no current route exists", async () => {
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "Historical route", body: "recover through pull", dedupeKey: "push:no-current-route:a" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:no-current-route:a") as { id: number };
  db.prepare("DELETE FROM profile_notification_reads WHERE profile_id = ? AND notification_id = ?")
    .run("profile-a", notification.id);
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'sent', sent_at = ?
    WHERE profile_id = ? AND notification_id = ?
  `).run(new Date().toISOString(), "profile-a", notification.id);
  const routes = (configModule.config as { profilePushRoutes: Record<string, { route: string; url: string; secret: string }> }).profilePushRoutes;
  const original = routes["profile-a"];
  delete routes["profile-a"];
  let notices;
  try {
    notices = pullPending(requireProfileContext("profile-a"));
  } finally {
    routes["profile-a"] = original;
  }
  assert.equal(notices.filter((notice) => notice.title === "Historical route").length, 1);
});

test("notify.pull cancels a pending QQ delivery after the user has seen it", async () => {
  await publishProfile({ profileId: "profile-b", source: "schedule", title: "Seen in chat", body: "cancel QQ duplicate", dedupeKey: "push:pull:b" });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:pull:b") as { id: number };

  const notices = pullPending(requireProfileContext("profile-b"));
  assert.equal(notices.some((notice) => notice.title === "Seen in chat"), true);
  const row = db.prepare(`
    SELECT status FROM profile_notification_deliveries
    WHERE profile_id = ? AND notification_id = ? AND route = ?
  `).get("profile-b", notification.id, "qqbot") as Record<string, unknown>;
  assert.equal(row.status, "cancelled");
});

test("scheduler tick actively delivers a newly due Profile reminder", async () => {
  const schedule = createSchedule(requireProfileContext("profile-a"), {
    title: "active QQ reminder",
    calendar: "solar",
    date: "2020-01-02",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  const requests: string[] = [];
  db.prepare("UPDATE schedules SET enabled = 0 WHERE NOT (profile_id = ? AND id = ?)")
    .run("profile-a", schedule.id);
  const fetchImpl = (async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  assert.equal(typeof runSchedulerTick, "function");
  const result = await runSchedulerTick(new Date("2100-03-01T00:00:00.000Z"), fetchImpl);
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
  assert.deepEqual(requests, ["http://127.0.0.1:8644/webhooks/life-assistant-reminder"]);
  const delivery = db.prepare(`
    SELECT d.status FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE n.dedupe_key LIKE ?
  `).get(`schedule:profile-a:${schedule.id}:%`) as Record<string, unknown>;
  assert.equal(delivery.status, "sent");
});

test("M7: runSchedulerTick skips delivery when the mid-tick lease check fails, delivers when it passes", async () => {
  const schedule = createSchedule(requireProfileContext("profile-a"), {
    title: "leaseCheck gated reminder",
    calendar: "solar",
    date: "2020-01-02",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  const requests: string[] = [];
  db.prepare("UPDATE schedules SET enabled = 0 WHERE NOT (profile_id = ? AND id = ?)")
    .run("profile-a", schedule.id);
  const fetchImpl = (async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const deliveryOf = () => db.prepare(`
    SELECT d.status FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE n.dedupe_key LIKE ?
  `).get(`schedule:profile-a:${schedule.id}:%`) as Record<string, unknown> | undefined;

  try {
    // 租约复核失败：模块 tick 照常扫描发布（提醒行已物化），但投递整体跳过、行保持
    // pending——防止租约已被第二实例接管后的并行投递（M7 后半）。
    const skipped = await runSchedulerTick(new Date("2100-03-02T00:00:00.000Z"), fetchImpl, { leaseCheck: () => false });
    assert.deepEqual(skipped, { attempted: 0, sent: 0, failed: 0 });
    assert.deepEqual(requests, []);
    const pending = deliveryOf();
    assert.ok(pending, "提醒已发布，delivery 行应存在");
    assert.equal(pending.status, "pending");

    // 租约复核通过：同一投递正常发送。
    const delivered = await runSchedulerTick(new Date("2100-03-02T00:01:00.000Z"), fetchImpl, { leaseCheck: () => true });
    assert.deepEqual(delivered, { attempted: 1, sent: 1, failed: 0 });
    assert.equal(deliveryOf()?.status, "sent");
  } finally {
    db.prepare("UPDATE schedules SET enabled = 0 WHERE profile_id = ? AND id = ?").run("profile-a", schedule.id);
  }
});

test("a due reminder stores the new semantic snapshot with Profile-scoped target identity", async () => {
  // 动态"明天"：避免固定日期过期后 createSchedule 跳到下一年（日期炸弹）
  const tomorrowShanghai = DateTime.now().setZone("Asia/Shanghai").plus({ days: 1 }).startOf("day");
  const schedule = createSchedule(requireProfileContext("profile-a"), {
    type: "anniversary",
    title: "semantic bridge reminder",
    note: "structured only for now",
    priority: "high",
    calendar: "solar",
    date: tomorrowShanghai.toFormat("yyyy-MM-dd"),
    time: "09:30",
    timezone: "Asia/Shanghai",
    reminders: [{ id: "one-hour", minutesBefore: 60 }],
  });
  db.prepare("UPDATE schedules SET enabled = 0 WHERE NOT (profile_id = ? AND id = ?)")
    .run("profile-a", schedule.id);

  const dueAt = tomorrowShanghai.plus({ hours: 8, minutes: 30 }).toUTC().toJSDate();
  await runDueSchedules(dueAt);
  await runDueSchedules(dueAt);

  const occurrenceKey = `${tomorrowShanghai.plus({ hours: 9, minutes: 30 }).toUTC().toISO()}:occurrence:one-hour`;
  const rows = db.prepare(`
    SELECT profile_id, source, title, body, dedupe_key
    FROM profile_notifications
    WHERE dedupe_key = ?
  `).all(`schedule:profile-a:${schedule.id}:${occurrenceKey}`) as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => ({ ...row })), [{
    profile_id: "profile-a",
    source: "schedule",
    title: "纪念日 · 发生提醒：semantic bridge reminder",
    body: [
      "纪念日 · 发生提醒：semantic bridge reminder",
      "发生时间：今天 09:30",
      "相对：还有 1 小时 0 分钟",
      "备注：structured only for now",
    ].join("\n"),
    dedupe_key: `schedule:profile-a:${schedule.id}:${occurrenceKey}`,
  }]);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ? AND occurrence_key = ?
  `).get("profile-a", schedule.id, occurrenceKey)?.count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notifications
    WHERE profile_id = ? AND title = ?
  `).get("profile-b", "semantic bridge reminder")?.count, 0);
});

test("准时提醒快照不受 tick 亚分钟抖动影响（渲染为现在而非逾期 1 分钟）", async () => {
  // 动态"明天"：避免固定日期过期后 createSchedule 跳到下一年（日期炸弹）。
  const tomorrowShanghai = DateTime.now().setZone("Asia/Shanghai").plus({ days: 1 }).startOf("day");
  const schedule = createSchedule(requireProfileContext("profile-a"), {
    title: "准时提醒不显示逾期",
    calendar: "solar",
    date: tomorrowShanghai.toFormat("yyyy-MM-dd"),
    time: "09:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  db.prepare("UPDATE schedules SET enabled = 0 WHERE NOT (profile_id = ? AND id = ?)")
    .run("profile-a", schedule.id);

  // tick 墙钟比计划触发时刻晚 5 秒（cron 回调的固有抖动）。
  const triggerAt = tomorrowShanghai.plus({ hours: 9 }).toUTC().toJSDate();
  await runDueSchedules(new Date(triggerAt.getTime() + 5_000));

  const occurrenceKey = `${tomorrowShanghai.plus({ hours: 9 }).toUTC().toISO()}:occurrence:reminder-1`;
  const row = db.prepare(`
    SELECT body FROM profile_notifications
    WHERE profile_id = ? AND dedupe_key = ?
  `).get("profile-a", `schedule:profile-a:${schedule.id}:${occurrenceKey}`) as { body: string } | undefined;
  assert.ok(row, "准时提醒应已落库");
  assert.match(row.body, /相对：现在/);
  assert.doesNotMatch(row.body, /已逾期/);
});

test("a notification insert failure does not consume the schedule occurrence", async () => {
  const schedule = createSchedule(requireProfileContext("profile-a"), {
    title: "retry-safe reminder",
    calendar: "solar",
    date: "2020-01-03",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  db.exec(`
    CREATE TRIGGER fail_test_notification
    BEFORE INSERT ON profile_notifications
    WHEN NEW.dedupe_key LIKE 'schedule:profile-a:${schedule.id}:%'
    BEGIN
      SELECT RAISE(FAIL, 'forced notification failure');
    END;
  `);
  await assert.rejects(
    () => runDueSchedules(new Date("2100-04-01T00:00:00.000Z")),
    /forced notification failure/,
  );
  const afterFailure = db.prepare(
    "SELECT COUNT(*) AS count FROM schedule_occurrences WHERE profile_id = ? AND schedule_id = ?",
  ).get("profile-a", schedule.id) as { count: number };
  assert.equal(afterFailure.count, 0);

  db.exec("DROP TRIGGER fail_test_notification");
  await runDueSchedules(new Date("2100-04-01T00:00:00.000Z"));
  const afterRetry = db.prepare(
    "SELECT COUNT(*) AS count FROM schedule_occurrences WHERE profile_id = ? AND schedule_id = ?",
  ).get("profile-a", schedule.id) as { count: number };
  assert.equal(afterRetry.count, 1);
});

test("a poison schedule does not starve healthy schedules or existing QQ outbox", async () => {
  await publishProfile({ profileId: "profile-b", source: "schedule", title: "Existing outbox", body: "must still send", dedupeKey: "push:existing:b" });
  const existingNotification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:existing:b") as { id: number };
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE notification_id NOT IN (
      SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
    )
  `).run("profile-b", "push:existing:b");

  const poison = createSchedule(requireProfileContext("profile-a"), {
    title: "poison reminder",
    calendar: "solar",
    date: "2019-01-01",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  const healthy = createSchedule(requireProfileContext("profile-a"), {
    title: "healthy reminder",
    calendar: "solar",
    date: "2020-01-04",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  db.prepare("UPDATE schedules SET enabled = 0 WHERE id NOT IN (?, ?)").run(poison.id, healthy.id);
  db.exec(`
    CREATE TRIGGER fail_poison_notification
    BEFORE INSERT ON profile_notifications
    WHEN NEW.dedupe_key LIKE 'schedule:profile-a:${poison.id}:%'
    BEGIN
      SELECT RAISE(FAIL, 'poison schedule failure');
    END;
  `);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  await assert.rejects(
    () => runSchedulerTick(new Date("2100-05-01T00:00:00.000Z"), fetchImpl),
    /poison schedule failure/,
  );
  db.exec("DROP TRIGGER fail_poison_notification");

  const healthyOccurrences = db.prepare(
    "SELECT COUNT(*) AS count FROM schedule_occurrences WHERE profile_id = ? AND schedule_id = ?",
  ).get("profile-a", healthy.id) as { count: number };
  const existingDelivery = db.prepare(
    "SELECT status FROM profile_notification_deliveries WHERE profile_id = ? AND notification_id = ?",
  ).get("profile-b", existingNotification.id) as Record<string, unknown>;
  assert.equal(healthyOccurrences.count, 1);
  assert.equal(existingDelivery.status, "sent");
  assert.ok(calls >= 1);
});

test("more than 500 poison schedules cannot starve a later healthy schedule", async () => {
  db.prepare("UPDATE schedules SET enabled = 0").run();
  for (let index = 0; index < 500; index += 1) {
    createSchedule(requireProfileContext("profile-a"), {
      title: `poison batch ${index}`,
      calendar: "solar",
      date: "2019-01-01",
      time: "00:00",
      timezone: "Asia/Shanghai",
      reminders: [{ minutesBefore: 0 }],
    });
  }
  const healthy = createSchedule(requireProfileContext("profile-a"), {
    title: "healthy after 500 poison schedules",
    calendar: "solar",
    date: "2020-01-05",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  db.exec(`
    CREATE TRIGGER fail_poison_batch_notifications
    BEFORE INSERT ON profile_notifications
    WHEN NEW.title LIKE '%poison batch %'
    BEGIN
      SELECT RAISE(FAIL, 'poison batch failure');
    END;
  `);
  try {
    await assert.rejects(
      () => runDueSchedules(new Date("2100-06-01T00:00:00.000Z")),
      /due schedules failed|poison batch failure/,
    );
  } finally {
    db.exec("DROP TRIGGER fail_poison_batch_notifications");
  }
  const occurrence = db.prepare(`
    SELECT COUNT(*) AS count FROM schedule_occurrences
    WHERE profile_id = ? AND schedule_id = ?
  `).get("profile-a", healthy.id) as { count: number };
  try {
    assert.equal(occurrence.count, 1);
  } finally {
    db.prepare("DELETE FROM profile_notifications WHERE title LIKE 'poison batch %' OR title = ?")
      .run("healthy after 500 poison schedules");
    db.prepare("DELETE FROM schedules WHERE title LIKE 'poison batch %' OR title = ?")
      .run("healthy after 500 poison schedules");
  }
});

test("L4: a delivery failure joins module tick errors in the aggregated rejection", async () => {
  // 模块 tick 失败（poison trigger）+ 投递失败（打桩）必须一起出现在 AggregateError 里，
  // 而不是让投递异常吞掉已收集的模块错误（runSchedulerTick 的 errors 通道）。
  await publishProfile({ profileId: "profile-a", source: "schedule", title: "L4 outbox", body: "delivery row", dedupeKey: "push:l4-delivery:a" });
  const poison = createSchedule(requireProfileContext("profile-a"), {
    title: "L4 poison reminder",
    calendar: "solar",
    date: "2018-01-01",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  db.prepare("UPDATE schedules SET enabled = 0 WHERE NOT (profile_id = ? AND id = ?)")
    .run("profile-a", poison.id);
  db.exec(`
    CREATE TRIGGER fail_l4_notification
    BEFORE INSERT ON profile_notifications
    WHEN NEW.dedupe_key LIKE 'schedule:profile-a:${poison.id}:%'
    BEGIN
      SELECT RAISE(FAIL, 'module tick boom');
    END;
  `);
  const originalPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    if (String(sql).includes("UPDATE profile_notification_deliveries")) {
      return {
        run: () => { throw new Error("delivery boom"); },
      } as unknown as ReturnType<typeof db.prepare>;
    }
    return originalPrepare(sql);
  }) as typeof db.prepare;
  try {
    await assert.rejects(
      () => runSchedulerTick(new Date("2100-08-01T00:00:00.000Z"), fetch),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError, `expected AggregateError, got ${String(error)}`);
        assert.deepEqual(
          (error as AggregateError).errors.map((entry) => (entry as Error).message).sort(),
          ["delivery boom", "module tick boom"],
        );
        return true;
      },
    );
  } finally {
    (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    db.exec("DROP TRIGGER IF EXISTS fail_l4_notification");
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run("profile-a", poison.id);
    db.prepare("DELETE FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?")
      .run("profile-a", "push:l4-delivery:a");
  }
});

test("scheduler claims a singleton lease and emits only the target Profile notice", async () => {
  assert.equal(acquireSchedulerLease("test-owner"), true);
  assert.equal(acquireSchedulerLease("other-owner"), false);
  releaseSchedulerLease("test-owner");
  assert.equal(acquireSchedulerLease("other-owner"), true);
  releaseSchedulerLease("other-owner");

  const a = requireProfileContext("profile-a");
  const schedule = createSchedule(a, {
    title: "due item",
    calendar: "solar",
    date: "2020-01-01",
    time: "00:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  await runDueSchedules(new Date("2026-08-02T00:00:00.000Z"));
  const aNotices = pullPending(a);
  const bNotices = pullPending(requireProfileContext("profile-b"));
  assert.equal(aNotices.some((n) => n.body.includes(schedule.title)), true);
  assert.equal(bNotices.some((n) => n.body.includes(schedule.title)), false);
});

test("a displaced scheduler owner cannot refresh or reacquire through the heartbeat path", () => {
  assert.equal(acquireSchedulerLease("stale-owner"), true);
  assert.equal(refreshSchedulerLease("stale-owner"), true);
  db.prepare("UPDATE scheduler_lease SET owner = ? WHERE name = ?").run("replacement-owner", "scheduler");
  assert.equal(refreshSchedulerLease("stale-owner"), false);
  db.prepare("DELETE FROM scheduler_lease WHERE name = ?").run("scheduler");
  assert.equal(refreshSchedulerLease("stale-owner"), false);
});

test("schema v2 upgrades to a valid v4 delivery outbox", () => {
  assert.equal(typeof migrateDatabaseSchema, "function");
  const legacy = new DatabaseSync(":memory:");
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta(key, value) VALUES('version', '2');
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
  `);
  migrateDatabaseSchema(legacy);
  const version = legacy.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string };
  const columns = legacy.prepare("PRAGMA table_info(profile_notification_deliveries)").all() as Array<{ name: string }>;
  assert.equal(version.value, "8");
  assert.equal(columns.some((column) => column.name === "claim_token"), true);
  assert.equal(columns.some((column) => column.name === "transport_failures"), true);
  assert.equal(columns.some((column) => column.name === "request_started_at"), true);

  const inserted = legacy.prepare(`
    INSERT INTO profile_notifications(profile_id, source, title, body, created_at, dedupe_key)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run("default", "schedule", "title", "body", "2026-08-02T00:00:00.000Z", "upgrade:test") as { lastInsertRowid: number | bigint };
  legacy.prepare(`
    INSERT INTO profile_notification_deliveries(
      profile_id, notification_id, route, next_attempt_at, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?)
  `).run("default", Number(inserted.lastInsertRowid), "qqbot", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z");
  assert.deepEqual(legacy.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => legacy.prepare(`
    INSERT INTO profile_notification_deliveries(
      profile_id, notification_id, route, next_attempt_at, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?)
  `).run("bestie", Number(inserted.lastInsertRowid), "qqbot", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z"), /FOREIGN KEY/);
  legacy.close();
});

test("migration namespaces legacy shared schedule data instead of copying it", () => {
  const rows = db.prepare("SELECT profile_id FROM schedules WHERE title = ?").all("A private anniversary") as Array<{ profile_id: string }>;
  assert.deepEqual(rows.map((r) => r.profile_id), ["profile-a"]);
});

test("solar and lunar annual rules support normal and leap month policies", () => {
  const a = requireProfileContext("profile-a");
  const normal = createSchedule(a, {
    title: "lunar normal birthday",
    calendar: "lunar",
    lunarMonth: 6,
    lunarDay: 8,
    leapMonthPolicy: "normal",
    time: "08:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  const leap = createSchedule(a, {
    title: "lunar leap birthday",
    calendar: "lunar",
    lunarMonth: 6,
    lunarDay: 8,
    leapMonthPolicy: "leap",
    time: "08:00",
    timezone: "Asia/Shanghai",
    reminders: [{ minutesBefore: 0 }],
  });
  assert.equal(normal.recurrence.calendar, "lunar");
  assert.equal(leap.recurrence.leapMonthPolicy, "leap");
  assert.ok(normal.nextRunAt);
  assert.ok(leap.nextRunAt);
});

test("Chinese lunar conversion preserves a known lunar new year date", () => {
  const solar = Lunar.fromYmd(2024, 1, 1).getSolar();
  assert.equal(solar.toYmd(), "2024-02-10");
  assert.equal(Solar.fromYmd(2024, 2, 10).getLunar().getMonth(), 1);
  assert.equal(Solar.fromYmd(2024, 2, 10).getLunar().getDay(), 1);
});

test("partial update preserves the calendar of a lunar schedule", () => {
  const a = requireProfileContext("profile-a");
  const created = createSchedule(a, {
    title: "农历纪念日",
    calendar: "lunar",
    lunarMonth: 1,
    lunarDay: 1,
    timezone: "Asia/Shanghai",
  });
  const updated = updateSchedule(a, created.id, { title: "改名后的农历纪念日" });
  assert.equal(updated.calendar, "lunar");
  assert.equal(updated.recurrence.calendar, "lunar");
  assert.equal(updated.title, "改名后的农历纪念日");
});

// ============================================================================
// 阶段 D：端到端集成验证（双 Profile 分别渲染 / 快照即投递 / 降级路径）
//
// 关键语义：渲染只发生在「入队/物化」前（publishNotification → renderForProfile fan-out），
// profile_notifications 只存 title/body 快照；投递/重试/notify.pull 全部读快照，不重渲染。
// 5 参 publishGlobal 不按 Profile 渲染，因此本阶段 global 用例一律走 publishNotification
// （默认解析器按 config.profilePushRoutes 的 renderTarget 求每 Profile target）。
// ============================================================================

type StageDRoute = { route: string; url: string; secret: string; renderTarget?: string };

const stageDWeatherEnvelope = (identity: string, scope: NotificationEnvelope["scope"]): NotificationEnvelope => ({
  kind: "weather.daily_brief",
  identity,
  source: "weather",
  scope,
  headline: "萍乡今天晴，最高33℃",
  generatedAt: "2026-08-10T07:00:00+08:00",
  payload: { city: "萍乡", today: { weather: "晴", minTemperatureC: 25, maxTemperatureC: 33 } },
});

test("阶段D：双 Profile 不同 renderTarget 的 global 事件分别渲染（qq-markdown vs plain）", async () => {
  const routes = (configModule.config as { profilePushRoutes: Record<string, StageDRoute> }).profilePushRoutes;
  const originalA = routes["profile-a"];
  const originalB = routes["profile-b"];
  routes["profile-a"] = { ...originalA, renderTarget: "qq-markdown" };
  routes["profile-b"] = { ...originalB }; // 无 renderTarget → 缺省 plain
  try {
    await publishNotification(stageDWeatherEnvelope("stage-d:render:diff:1", { type: "global" }), {});

    const rows = db.prepare(`
      SELECT profile_id, title, body FROM profile_notifications
      WHERE dedupe_key = ? ORDER BY profile_id
    `).all("weather:stage-d:render:diff:1") as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { profile_id: "profile-a", title: "# 萍乡今天晴，最高33℃", body: "**今日**：25～33℃，晴" },
      { profile_id: "profile-b", title: "萍乡今天晴，最高33℃", body: "今日：25～33℃，晴" },
    ]);

    const deliveries = db.prepare(`
      SELECT d.profile_id, d.status FROM profile_notification_deliveries d
      JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
      WHERE n.dedupe_key = ? ORDER BY d.profile_id
    `).all("weather:stage-d:render:diff:1") as Array<Record<string, unknown>>;
    assert.deepEqual(deliveries.map((row) => ({ ...row })), [
      { profile_id: "profile-a", status: "pending" },
      { profile_id: "profile-b", status: "pending" },
    ]);
  } finally {
    routes["profile-a"] = originalA;
    routes["profile-b"] = originalB;
  }
});

test("阶段D：双 Profile 不同 renderTarget 的 global 事件分别渲染（qq-markdown vs wechat-markdown）", async () => {
  const routes = (configModule.config as { profilePushRoutes: Record<string, StageDRoute> }).profilePushRoutes;
  const originalA = routes["profile-a"];
  const originalB = routes["profile-b"];
  routes["profile-a"] = { ...originalA, renderTarget: "qq-markdown" };
  routes["profile-b"] = { ...originalB, renderTarget: "wechat-markdown" };
  try {
    await publishNotification(stageDWeatherEnvelope("stage-d:render:wechat:1", { type: "global" }), {});

    const rows = db.prepare(`
      SELECT profile_id, title, body FROM profile_notifications
      WHERE dedupe_key = ? ORDER BY profile_id
    `).all("weather:stage-d:render:wechat:1") as Array<Record<string, unknown>>;
    // 当前三平台 markdown 同集（D6：QQ/飞书/微信统一保守集合）——关键断言是
    // wechat-markdown 从配置解析并进入 fan-out：profile-b 不再按缺省回落 plain。
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { profile_id: "profile-a", title: "# 萍乡今天晴，最高33℃", body: "**今日**：25～33℃，晴" },
      { profile_id: "profile-b", title: "# 萍乡今天晴，最高33℃", body: "**今日**：25～33℃，晴" },
    ]);

    const deliveries = db.prepare(`
      SELECT d.profile_id, d.status FROM profile_notification_deliveries d
      JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
      WHERE n.dedupe_key = ? ORDER BY d.profile_id
    `).all("weather:stage-d:render:wechat:1") as Array<Record<string, unknown>>;
    assert.deepEqual(deliveries.map((row) => ({ ...row })), [
      { profile_id: "profile-a", status: "pending" },
      { profile_id: "profile-b", status: "pending" },
    ]);
  } finally {
    routes["profile-a"] = originalA;
    routes["profile-b"] = originalB;
  }
});

test("阶段D：日程 due reminder 在 qq-markdown profile 落库为 markdown 快照，plain profile 保持纯文本", async () => {
  const routes = (configModule.config as { profilePushRoutes: Record<string, StageDRoute> }).profilePushRoutes;
  const originalA = routes["profile-a"];
  const originalB = routes["profile-b"];
  routes["profile-a"] = { ...originalA, renderTarget: "qq-markdown" };
  routes["profile-b"] = { ...originalB }; // 无 renderTarget → plain
  try {
    // 动态"明天"：避免固定日期过期后 createSchedule 跳到下一年（日期炸弹）。
    const tomorrowShanghai = DateTime.now().setZone("Asia/Shanghai").plus({ days: 1 }).startOf("day");
    const scheduleA = createSchedule(requireProfileContext("profile-a"), {
      type: "birthday",
      title: "render markdown reminder",
      note: "render markdown note",
      priority: "high",
      calendar: "solar",
      date: tomorrowShanghai.toFormat("yyyy-MM-dd"),
      time: "09:30",
      timezone: "Asia/Shanghai",
      reminders: [{ id: "one-hour", minutesBefore: 60 }],
    });
    const scheduleB = createSchedule(requireProfileContext("profile-b"), {
      type: "birthday",
      title: "render plain reminder",
      note: "render plain note",
      priority: "high",
      calendar: "solar",
      date: tomorrowShanghai.toFormat("yyyy-MM-dd"),
      time: "09:30",
      timezone: "Asia/Shanghai",
      reminders: [{ id: "one-hour", minutesBefore: 60 }],
    });
    db.prepare("UPDATE schedules SET enabled = 0 WHERE id NOT IN (?, ?)").run(scheduleA.id, scheduleB.id);

    const dueAt = tomorrowShanghai.plus({ hours: 8, minutes: 30 }).toUTC().toJSDate();
    await runDueSchedules(dueAt);

    const occurrenceKey = `${tomorrowShanghai.plus({ hours: 9, minutes: 30 }).toUTC().toISO()}:occurrence:one-hour`;
    const rows = db.prepare(`
      SELECT profile_id, source, title, body, dedupe_key
      FROM profile_notifications
      WHERE dedupe_key IN (?, ?)
      ORDER BY profile_id
    `).all(
      `schedule:profile-a:${scheduleA.id}:${occurrenceKey}`,
      `schedule:profile-b:${scheduleB.id}:${occurrenceKey}`,
    ) as Array<Record<string, unknown>>;

    assert.deepEqual(rows.map((row) => ({ ...row })), [
      {
        profile_id: "profile-a",
        source: "schedule",
        title: "# 生日 · 发生提醒：render markdown reminder",
        body: "**发生时间**：今天 09:30\n\n**相对**：还有 1 小时 0 分钟\n\n**备注**：render markdown note",
        dedupe_key: `schedule:profile-a:${scheduleA.id}:${occurrenceKey}`,
      },
      {
        profile_id: "profile-b",
        source: "schedule",
        title: "生日 · 发生提醒：render plain reminder",
        body: "生日 · 发生提醒：render plain reminder\n发生时间：今天 09:30\n相对：还有 1 小时 0 分钟\n备注：render plain note",
        dedupe_key: `schedule:profile-b:${scheduleB.id}:${occurrenceKey}`,
      },
    ]);

    // 两个 Profile 各有一个 pending delivery（快照即投递的 outbox 侧）。
    const deliveries = db.prepare(`
      SELECT d.profile_id, d.status, d.route FROM profile_notification_deliveries d
      JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
      WHERE n.dedupe_key IN (?, ?)
      ORDER BY d.profile_id
    `).all(
      `schedule:profile-a:${scheduleA.id}:${occurrenceKey}`,
      `schedule:profile-b:${scheduleB.id}:${occurrenceKey}`,
    ) as Array<Record<string, unknown>>;
    assert.deepEqual(deliveries.map((row) => ({ ...row })), [
      { profile_id: "profile-a", status: "pending", route: "qqbot" },
      { profile_id: "profile-b", status: "pending", route: "qqbot" },
    ]);
  } finally {
    routes["profile-a"] = originalA;
    routes["profile-b"] = originalB;
  }
});

test("阶段D：快照即投递——webhook body 的 title/body 与落库快照逐字一致（不重渲染）", async () => {
  const routes = (configModule.config as { profilePushRoutes: Record<string, StageDRoute> }).profilePushRoutes;
  const originalA = routes["profile-a"];
  routes["profile-a"] = { ...originalA, renderTarget: "qq-markdown" };
  try {
    await publishNotification(stageDWeatherEnvelope("stage-d:snapshot:delivery:1", { type: "profile", profileId: "profile-a" }), {});

    const dedupeKey = "weather:stage-d:snapshot:delivery:1";
    const snapshot = db.prepare(`
      SELECT title, body FROM profile_notifications
      WHERE profile_id = ? AND dedupe_key = ?
    `).get("profile-a", dedupeKey) as { title: string; body: string };
    assert.equal(snapshot.title, "# 萍乡今天晴，最高33℃");
    assert.equal(snapshot.body, "**今日**：25～33℃，晴");

    // 只投递本条：取消 profile-a 其他历史 delivery，避免干扰 summary/请求计数。
    db.prepare(`
      UPDATE profile_notification_deliveries SET status = 'cancelled'
      WHERE notification_id NOT IN (
        SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?
      )
    `).run("profile-a", dedupeKey);

    const at = new Date("2100-01-01T00:00:00.000Z");
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const summary = await deliverPendingProfileNotifications({ at, profileId: "profile-a", fetchImpl, clock: () => at });
    assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:8644/webhooks/life-assistant-reminder");

    const payload = JSON.parse(requests[0].body) as {
      event_type: string;
      notification: { profileId: string; source: string; title: string; body: string; createdAt: string };
    };
    assert.equal(payload.event_type, "life_assistant.reminder");
    assert.equal(payload.notification.profileId, "profile-a");
    assert.equal(payload.notification.source, "weather");
    assert.equal(payload.notification.title, snapshot.title);
    assert.equal(payload.notification.body, snapshot.body);
    assert.ok(payload.notification.createdAt);
  } finally {
    routes["profile-a"] = originalA;
  }
});

test("阶段D：降级路径——内置 renderNotification 平台分支对残缺 payload 恒不 throw（plain 兜底契约）", () => {
  const minimal: NotificationEnvelope = {
    kind: "schedule.reminder",
    identity: "stage-d:profile-a:schedule-min:occurrence-1",
    source: "schedule",
    scope: { type: "profile", profileId: "profile-a" },
    headline: "minimal reminder",
    generatedAt: "2026-08-10T00:00:00.000Z",
    payload: {
      title: "minimal reminder",
      eventAt: "2026-08-10T09:30:00+08:00",
      timezone: "Asia/Shanghai",
      reminderMinutes: 0,
    },
  };
  const targets: NotificationRenderTarget[] = ["plain", "qq-markdown", "feishu-markdown", "wechat-markdown"];
  for (const target of targets) {
    const rendered = renderNotification(minimal, target);
    assert.equal(typeof rendered.title, "string");
    assert.equal(typeof rendered.body, "string");
    assert.ok(rendered.title.length > 0, `${target} title 不得为空`);
    assert.ok(rendered.body.length > 0, `${target} body 不得为空`);
  }
  // 未知/非法 target 恒回落 plain（未知平台兜底）。
  assert.deepEqual(renderNotification(minimal, "unknown-platform" as any), renderNotification(minimal, "plain"));
});

test("阶段D：降级路径——注入 renderer 抛错保持抛出语义（D5-A），不产生部分落库/投递", async () => {
  const routes = (configModule.config as { profilePushRoutes: Record<string, StageDRoute> }).profilePushRoutes;
  const originalA = routes["profile-a"];
  const originalB = routes["profile-b"];
  routes["profile-a"] = { ...originalA, renderTarget: "qq-markdown" };
  routes["profile-b"] = { ...originalB };
  try {
    // 现有实现语义（决策 D5-A）：兜底只保证默认 renderNotification 的平台分支
    // （try/catch → plain）；注入的 renderer 是显式测试/扩展接缝，保持抛出语义不变，
    // 因此 publishNotification 整体 reject，且 fan-out 原子失败（不写半截落库/投递）。
    await assert.rejects(
      () => publishNotification(stageDWeatherEnvelope("stage-d:degrade:renderer:1", { type: "global" }), {
        renderer: () => { throw new Error("boom"); },
      }),
      /boom/,
    );
    const rows = db.prepare("SELECT COUNT(*) AS count FROM profile_notifications WHERE dedupe_key = ?")
      .get("weather:stage-d:degrade:renderer:1") as { count: number };
    assert.equal(rows.count, 0);
    const deliveries = db.prepare(`
      SELECT COUNT(*) AS count FROM profile_notification_deliveries d
      JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
      WHERE n.dedupe_key = ?
    `).get("weather:stage-d:degrade:renderer:1") as { count: number };
    assert.equal(deliveries.count, 0);
  } finally {
    routes["profile-a"] = originalA;
    routes["profile-b"] = originalB;
  }
});

test("hydration tolerates malformed recurrence_json and reminders_json without throwing", () => {
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  const insert = (id: string, recurrenceJson: string, remindersJson: string) => {
    db.prepare(`
      INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, time, all_day, timezone, recurrence_json, reminders_json, enabled, version, created_at, updated_at)
      VALUES(?, ?, 'todo', ?, 'normal', 'active', 'solar', '09:00', 1, 'Asia/Shanghai', ?, ?, 0, 1, ?, ?)
    `).run(a.id, id, `hydration ${id}`, recurrenceJson, remindersJson, stamp, stamp);
  };
  try {
    insert("hydrate-null-recurrence", "null", "[{\"minutesBefore\":30,\"id\":\"r1\"}]");
    insert("hydrate-null-reminders", "{\"frequency\":\"daily\",\"interval\":1,\"calendar\":\"solar\"}", "null");
    insert("hydrate-empty-reminders", "{\"frequency\":\"daily\",\"interval\":1,\"calendar\":\"solar\"}", "[]");
    insert("hydrate-bad-shape", "{\"frequency\":\"hourly\",\"interval\":0,\"calendar\":\"solar\"}", "[{\"minutesBefore\":\"x\"},7,null]");

    // recurrence_json='null'：回退 {frequency:"once", interval:1, calendar}，提醒逐条归一化。
    const nullRecurrence = getSchedule(a, "hydrate-null-recurrence");
    assert.deepEqual(nullRecurrence.recurrence, { frequency: "once", interval: 1, calendar: "solar" });
    assert.deepEqual(nullRecurrence.reminders, [{ id: "r1", minutesBefore: 30, target: "occurrence" }]);
    // reminders_json='null'：回退默认提醒。
    assert.deepEqual(getSchedule(a, "hydrate-null-reminders").reminders, [
      { id: "reminder-1", minutesBefore: 0, target: "occurrence" },
    ]);
    // S4：合法空数组也回退默认提醒；空提醒集合会让日程永不触发，读取侧不再保留。
    assert.deepEqual(getSchedule(a, "hydrate-empty-reminders").reminders, [
      { id: "reminder-1", minutesBefore: 0, target: "occurrence" },
    ]);
    // frequency 非法/interval 非法 → 整体回退；reminder 非对象项被过滤、非法字段归零。
    const badShape = getSchedule(a, "hydrate-bad-shape");
    assert.deepEqual(badShape.recurrence, { frequency: "once", interval: 1, calendar: "solar" });
    assert.deepEqual(badShape.reminders, [{ id: "reminder-1", minutesBefore: 0, target: "occurrence" }]);
    assert.doesNotThrow(() => listSchedules(a));
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id LIKE 'hydrate-%'").run(a.id);
  }
});

test("hydration preserves lunar leap-month policy from the authoritative column", () => {
  // 二次审查 P0 回归：sanitizeRecurrence 曾丢弃 leapMonthPolicy，导致闰月日程
  // 在读取侧被按普通月计算。列值 leap_month_policy 是权威存储，JSON 漂移也必须以列值为准。
  const a = requireProfileContext("profile-a");
  const item = createSchedule(a, {
    title: "闰月纪念",
    calendar: "lunar",
    lunarMonth: 2,
    lunarDay: 10,
    leapMonthPolicy: "leap",
    timezone: "Asia/Shanghai",
  });
  try {
    const raw = db.prepare(
      "SELECT leap_month_policy, recurrence_json FROM schedules WHERE profile_id = ? AND id = ?",
    ).get(a.id, item.id) as Record<string, unknown>;
    assert.equal(raw.leap_month_policy, "leap");
    // 模拟 recurrence_json 漂移（缺 leapMonthPolicy）
    const drifted = JSON.parse(String(raw.recurrence_json)) as Record<string, unknown>;
    delete drifted.leapMonthPolicy;
    db.prepare("UPDATE schedules SET recurrence_json = ? WHERE profile_id = ? AND id = ?")
      .run(JSON.stringify(drifted), a.id, item.id);
    const hydrated = getSchedule(a, item.id);
    assert.equal(hydrated.recurrence.leapMonthPolicy, "leap");
    assert.equal(hydrated.isLeapMonth, true);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, item.id);
  }
});

test("legacy rows carrying both count and until can still be updated", () => {
  // 旧 schema 允许 count 与 until 共存；读取侧归一化（保留 count 丢弃 until），
  // 仅改标题的 update 不得被互斥校验误伤
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, date, time, all_day, timezone, recurrence_json, reminders_json, enabled, version, created_at, updated_at)
    VALUES(?, 'legacy-count-until', 'todo', 'legacy', 'normal', 'active', 'solar', '2099-01-02', '09:00', 1, 'Asia/Shanghai',
      '{"frequency":"daily","interval":1,"count":3,"until":"2099-01-31","calendar":"solar"}',
      '[{"minutesBefore":0,"id":"reminder-1","target":"occurrence"}]', 0, 1, ?, ?)
  `).run(a.id, stamp, stamp);
  try {
    const updated = updateSchedule(a, "legacy-count-until", { title: "renamed legacy" });
    assert.equal(updated.title, "renamed legacy");
    assert.equal(updated.recurrence.count, 3);
    assert.equal(updated.recurrence.until, undefined);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, "legacy-count-until");
  }
});

test("hydration drops format-legal but calendar-invalid until dates", () => {
  // "2099-02-30" 格式合法但日历非法：读取侧必须丢弃，否则 localDate/RRule 抛错
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, time, all_day, timezone, recurrence_json, reminders_json, enabled, version, created_at, updated_at)
    VALUES(?, 'legacy-bad-until', 'todo', 'bad until', 'normal', 'active', 'solar', '09:00', 1, 'Asia/Shanghai',
      '{"frequency":"daily","interval":1,"until":"2099-02-30","calendar":"solar"}',
      '[{"minutesBefore":0,"id":"reminder-1","target":"occurrence"}]', 0, 1, ?, ?)
  `).run(a.id, stamp, stamp);
  try {
    const item = getSchedule(a, "legacy-bad-until");
    assert.equal(item.recurrence.until, undefined);
    assert.doesNotThrow(() => listSchedules(a));
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, "legacy-bad-until");
  }
});

test("hydration re-ids duplicate reminder ids so no reminder is silently folded", () => {
  // 旧行含重复 id 时读取侧回退为位置 id，避免同 dedupe 键静默吞掉一条提醒
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, time, all_day, timezone, recurrence_json, reminders_json, enabled, version, created_at, updated_at)
    VALUES(?, 'legacy-dup-reminders', 'todo', 'dup', 'normal', 'active', 'solar', '09:00', 1, 'Asia/Shanghai',
      '{"frequency":"daily","interval":1,"calendar":"solar"}',
      '[{"id":"dup","minutesBefore":10},{"id":"dup","minutesBefore":20}]', 0, 1, ?, ?)
  `).run(a.id, stamp, stamp);
  try {
    const item = getSchedule(a, "legacy-dup-reminders");
    assert.equal(item.reminders.length, 2);
    assert.deepEqual(item.reminders.map((reminder) => reminder.id).sort(), ["dup", "reminder-2"]);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, "legacy-dup-reminders");
  }
});

test("the daily brief reuses the legacy same-day key so an upgrade-day run does not duplicate", () => {
  // 升级当天旧版本已按 weather:daily-brief:{date} 发布过：新代码传入 legacy 键，
  // 旧行应被改键复用而不是再插一条。日期选用未被其他测试占用的 2026-08-09。
  const options = {
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "北京", lat: 39.9, lon: 116.4 }),
    getAirQuality: async () => { throw new Error("aqi provider unavailable"); },
    getCurrent: async () => ({
      temperature: 28,
      apparent: 30,
      humidity: 61,
      windSpeed: 12,
      windSpeedUnit: "km/h" as const,
      weatherText: "多云",
    }),
    getForecast: async () => [{
      date: "2026-08-09",
      tMax: 32,
      tMin: 24,
      weatherText: "晴",
      precipProb: 10,
    }],
  };
  return (async () => {
    await publishProfile({ profileId: "profile-a", source: "weather", title: "旧键简报", body: "旧正文", dedupeKey: "weather:daily-brief:2026-08-09" });
    await runDailyWeatherBrief({ ...options, at: new Date("2026-08-09T07:00:00.000Z") });
    const rows = db.prepare(`
      SELECT dedupe_key, COUNT(*) AS count FROM profile_notifications
      WHERE profile_id = 'profile-a'
        AND dedupe_key IN ('weather:daily-brief:2026-08-09', 'weather:daily-brief:北京:2026-08-09')
      GROUP BY dedupe_key
    `).all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedupe_key, "weather:daily-brief:北京:2026-08-09");
    assert.equal(Number(rows[0].count), 1);
  })();
});

test("hydration re-ids entries that collide with auto-generated reminder ids", () => {
  // N1：自动生成的位置 id 也必须占位去重集合，否则 [{无id},{id:"reminder-1"}]
  // hydration 后得到两条 "reminder-1"，第二条被 occurrence key 静默折叠。
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, date, time, all_day, timezone, recurrence_json, reminders_json, enabled, version, created_at, updated_at)
    VALUES(?, 'legacy-dup-autogen', 'todo', 'dup autogen', 'normal', 'active', 'solar', '2099-01-02', '09:00', 1, 'Asia/Shanghai',
      '{"frequency":"daily","interval":1,"calendar":"solar"}',
      '[{"minutesBefore":0},{"id":"reminder-1","minutesBefore":10}]', 0, 1, ?, ?)
  `).run(a.id, stamp, stamp);
  try {
    const item = getSchedule(a, "legacy-dup-autogen");
    assert.equal(item.reminders.length, 2);
    assert.equal(new Set(item.reminders.map((reminder) => reminder.id)).size, 2);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, "legacy-dup-autogen");
  }
});

test("creating a lunar schedule with unimplemented leap policies is rejected", () => {
  // N3/D1-A：both/prefer-leap 未实现，输入路径明确拒绝，不保留一个不会正确执行的策略
  const a = requireProfileContext("profile-a");
  for (const policy of ["both", "prefer-leap"]) {
    assert.throws(() => createSchedule(a, {
      title: `policy ${policy}`,
      calendar: "lunar",
      lunarMonth: 2,
      lunarDay: 10,
      timezone: "Asia/Shanghai",
      leapMonthPolicy: policy as unknown as LeapMonthPolicy,
    }), /leapMonthPolicy/);
  }
});

test("hydration normalizes unimplemented leap policies to normal", () => {
  // N3/D1-A：legacy 行的 both/prefer-leap 读取侧归一为 normal（与 solarForLunar
  // 现行为一致），不再保留未实现策略
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, date, lunar_month, lunar_day, leap_month_policy, time, all_day, timezone, recurrence_json, reminders_json, enabled, version, created_at, updated_at)
    VALUES(?, 'legacy-leap-both', 'anniversary', 'leap both', 'normal', 'active', 'lunar', NULL, 2, 10, 'both', '09:00', 1, 'Asia/Shanghai',
      '{"frequency":"yearly","interval":1,"calendar":"lunar","leapMonthPolicy":"both"}',
      '[{"minutesBefore":0,"id":"reminder-1","target":"occurrence"}]', 0, 1, ?, ?)
  `).run(a.id, stamp, stamp);
  try {
    const item = getSchedule(a, "legacy-leap-both");
    assert.equal(item.recurrence.leapMonthPolicy, "normal");
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, "legacy-leap-both");
  }
});

test("hydration tolerates corrupt scalar columns without poisoning reads", () => {
  // N4/D2-A：timezone/date/time/next_run_at 标量列损坏时按默认值兜底，
  // 不让单行毒化 listSchedules/getSchedule
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  const insert = (id: string, overrides: { date?: string; time?: string; timezone?: string; nextRunAt?: string }) => {
    db.prepare(`
      INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, date, time, all_day, timezone, recurrence_json, reminders_json, enabled, next_run_at, version, created_at, updated_at)
      VALUES(?, ?, 'todo', ?, 'normal', 'active', 'solar', ?, ?, 1, ?, '{"frequency":"daily","interval":1,"calendar":"solar"}', '[{"minutesBefore":0,"id":"reminder-1","target":"occurrence"}]', 1, ?, 1, ?, ?)
    `).run(
      a.id, id, `scalar ${id}`,
      overrides.date ?? "2099-01-02",
      overrides.time ?? "09:00",
      overrides.timezone ?? "Asia/Shanghai",
      overrides.nextRunAt ?? "2099-01-03T00:00:00.000Z",
      stamp, stamp,
    );
  };
  try {
    insert("scalar-bad-timezone", { timezone: "Mars/Olympus" });
    insert("scalar-bad-date", { date: "2026-02-30" });
    insert("scalar-bad-time", { time: "99:99" });
    insert("scalar-bad-nextrun", { nextRunAt: "not-a-date" });

    assert.doesNotThrow(() => listSchedules(a));
    assert.equal(
      getSchedule(a, "scalar-bad-timezone").timezone,
      (configModule.config as { timezone: string }).timezone,
    );
    assert.equal(getSchedule(a, "scalar-bad-date").date, undefined);
    assert.equal(getSchedule(a, "scalar-bad-time").time, "09:00");
    const badNextRun = getSchedule(a, "scalar-bad-nextrun");
    assert.equal(badNextRun.nextRunAt, undefined);
    assert.equal(badNextRun.nextOccurrenceSolar, undefined);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id LIKE 'scalar-%'").run(a.id);
  }
});

test("an unexpected findOccurrence failure is logged and does not clear nextRunAt", () => {
  // P3-2：fromUtc（输入合法性）与 findOccurrence（逻辑推导）分离——
  // 后者的非预期异常必须有日志、且不清空 nextRunAt（不让日程静默停调度）。
  const a = requireProfileContext("profile-a");
  const item = createSchedule(a, {
    title: "derive boom",
    calendar: "solar",
    date: "2099-01-02",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
  });
  try {
    const raw = db.prepare("SELECT * FROM schedules WHERE profile_id = ? AND id = ?")
      .get(a.id, item.id) as Record<string, unknown>;
    assert.ok(raw.next_run_at, "fixture must have a non-null next_run_at");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      const failing = () => {
        throw new Error("unexpected findOccurrence failure");
      };
      const hydrated = hydrateRow(raw, failing);
      assert.equal(hydrated.nextRunAt, String(raw.next_run_at), "nextRunAt 保留");
      assert.equal(hydrated.nextOccurrenceSolar, undefined, "派生展示值丢弃");
      // P3-1：同一行窗口内重复失败只记一次完整日志（去重生效）
      hydrateRow(raw, failing);
      assert.equal(errors.length, 1, "窗口内同一行只记一次日志");
    } finally {
      console.error = original;
    }
    assert.ok(
      errors.some((line) => line.includes("unexpected findOccurrence failure")),
      "非预期异常必须记录日志",
    );
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, item.id);
  }
});

test("corrupt numeric columns fall back to safe defaults instead of NaN", () => {
  // P3-3：lunar_month/lunar_day/deadline_offset_minutes/version 损坏（NaN/越界/非整数）
  // 时按默认值兜底，不让 NaN 位移导致日程静默停用或提醒丢失。
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, date, time, all_day, timezone, recurrence_json, reminders_json, deadline_offset_minutes, enabled, next_run_at, version, created_at, updated_at)
    VALUES(?, 'numeric-bad-offset', 'todo', 'numeric offset', 'normal', 'active', 'solar', '2099-01-02', '09:00', 1, 'Asia/Shanghai',
      '{"frequency":"daily","interval":1,"calendar":"solar"}',
      '[{"minutesBefore":0,"id":"reminder-1","target":"occurrence"}]', 'abc', 1, '2099-01-03T00:00:00.000Z', 'abc', ?, ?)
  `).run(a.id, stamp, stamp);
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, date, lunar_month, lunar_day, leap_month_policy, time, all_day, timezone, recurrence_json, reminders_json, enabled, version, created_at, updated_at)
    VALUES(?, 'numeric-bad-lunar', 'anniversary', 'numeric lunar', 'normal', 'active', 'lunar', NULL, 'abc', 'abc', 'normal', '09:00', 1, 'Asia/Shanghai',
      '{"frequency":"yearly","interval":1,"calendar":"lunar"}',
      '[{"minutesBefore":0,"id":"reminder-1","target":"occurrence"}]', 0, 1, ?, ?)
  `).run(a.id, stamp, stamp);
  try {
    assert.doesNotThrow(() => listSchedules(a));
    const offset = getSchedule(a, "numeric-bad-offset");
    assert.equal(offset.deadlineOffsetMinutes, undefined);
    assert.equal(offset.version, 1);
    const lunar = getSchedule(a, "numeric-bad-lunar");
    assert.equal(lunar.lunarMonth, undefined);
    assert.equal(lunar.lunarDay, undefined);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id LIKE 'numeric-bad-%'").run(a.id);
  }
});

test("updating a schedule with a dirty legacy version does not conflict", () => {
  // P2-1：updateSchedule 的乐观锁 WHERE 必须与 hydration 归一化口径一致——
  // version=0 的脏行归一为 1 后，写回比较用原始列值，不得误报冲突。
  const a = requireProfileContext("profile-a");
  const item = createSchedule(a, {
    title: "dirty version",
    calendar: "solar",
    date: "2099-01-02",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  try {
    db.prepare("UPDATE schedules SET version = 0 WHERE profile_id = ? AND id = ?").run(a.id, item.id);
    const updated = updateSchedule(a, item.id, { title: "dirty version renamed" });
    assert.equal(updated.title, "dirty version renamed");
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, item.id);
  }
});

test("hydration errors are logged once per row within the dedup window", () => {
  // P3-1：同一 profileId/id 在 5 分钟窗口内只记一次完整日志；窗口外恢复记录；
  // 不同行互不抑制。用注入的假时钟使窗口可控。测试前后重置模块级 Map（N4 隔离）。
  resetHydrationErrorLog();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const base = 1_000;
    logHydrationError("profile-a", "dedup-id", new Error("boom"), base);
    logHydrationError("profile-a", "dedup-id", new Error("boom"), base + 4 * 60 * 1000); // 窗口内 → 抑制
    logHydrationError("profile-a", "other-id", new Error("other"), base);               // 不同行 → 记录
    assert.equal(errors.length, 2);
    logHydrationError("profile-a", "dedup-id", new Error("boom"), base + 5 * 60 * 1000 + 1); // 窗口外 → 恢复
    assert.equal(errors.length, 3);
  } finally {
    console.error = original;
    resetHydrationErrorLog();
  }
});

test("hydration error log bookkeeping cleans up expired entries", () => {
  // P3-1：过期条目不累积——阈值清扫时被回收（配合 N3 硬上限，Map 有界）
  resetHydrationErrorLog();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const expiredBase = Date.now() - 10 * 60 * 1000;
    for (let index = 0; index < 300; index += 1) {
      logHydrationError("profile-a", `bulk-${index}`, new Error("bulk"), expiredBase);
    }
    assert.equal(hydrationErrorLogSize(), 256, "未过期时 Map 停在硬上限（由 N3 淘汰最旧保证）");
    // 以"当前时间"记录一条新日志：触发阈值清扫，10 分钟前的过期条目被回收
    logHydrationError("profile-a", "fresh-entry", new Error("fresh"), Date.now());
    assert.ok(hydrationErrorLogSize() <= 10, "过期条目应被清扫，仅剩 fresh-entry 等未过期条目");
  } finally {
    console.error = original;
    resetHydrationErrorLog();
  }
});

test("the hydration error log map has a hard size cap", () => {
  // N3：全活跃（未过期）时 Map 也不得超过阈值——清理过期后仍超限则淘汰最旧条目
  resetHydrationErrorLog();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const base = Date.now();
    for (let index = 0; index < 300; index += 1) {
      logHydrationError("profile-a", `cap-${index}`, new Error("cap"), base);
    }
    assert.equal(hydrationErrorLogSize(), 256, "Map 不得超过硬上限");
    logHydrationError("profile-a", "cap-new", new Error("cap"), base);
    assert.equal(hydrationErrorLogSize(), 256, "新增条目后仍不得超过硬上限");
  } finally {
    console.error = original;
    resetHydrationErrorLog();
  }
});

test("updateSchedule reads the current row and raw version from a single snapshot", () => {
  // N1：乐观锁 WHERE 与 current 计算必须来自同一次读取（消除 T1→T2 二次读取的 TOCTOU 窗口）
  const a = requireProfileContext("profile-a");
  const item = createSchedule(a, {
    title: "single snapshot",
    calendar: "solar",
    date: "2099-01-02",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  try {
    const originalPrepare = db.prepare.bind(db) as typeof db.prepare;
    let snapshotSelects = 0;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = ((sql: string) => {
      if (String(sql).includes("SELECT * FROM schedules") || String(sql).includes("SELECT version FROM schedules")) {
        snapshotSelects += 1;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;
    try {
      const updated = updateSchedule(a, item.id, { title: "single snapshot renamed" });
      assert.equal(updated.title, "single snapshot renamed");
      assert.equal(snapshotSelects, 1, "整行快照与原始 version 应来自同一次读取");
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, item.id);
  }
});

test("S1: deleteSchedule cancels pending schedule reminders and deletes unread notification rows", async () => {
  const a = requireProfileContext("profile-a");
  const item = createSchedule(a, {
    title: "delete cancels pending reminder",
    calendar: "solar",
    date: "2099-12-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  const occurrenceAt = "2099-12-01T01:00:00.000Z";
  const dedupeKey = `schedule:${a.id}:${item.id}:${occurrenceAt}:reminder-1`;
  await publishProfile({ profileId: a.id, source: "schedule", title: "delete me", body: "body", dedupeKey });

  const pending = db.prepare(`
    SELECT d.status
    FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE n.dedupe_key = ?
  `).get(dedupeKey) as Record<string, unknown>;
  assert.equal(pending.status, "pending");

  deleteSchedule(a, item.id);

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM schedules WHERE profile_id = ? AND id = ?").get(a.id, item.id) as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?").get(a.id, dedupeKey) as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM profile_notification_deliveries d
      JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
      WHERE n.dedupe_key = ?
    `).get(dedupeKey) as { count: number }).count,
    0,
  );
});

test("S1: deleteSchedule keeps read schedule notifications but cancels their pending deliveries", async () => {
  const a = requireProfileContext("profile-a");
  const item = createSchedule(a, {
    title: "delete keeps read reminder",
    calendar: "solar",
    date: "2099-12-02",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  const occurrenceAt = "2099-12-02T01:00:00.000Z";
  const dedupeKey = `schedule:${a.id}:${item.id}:${occurrenceAt}:reminder-1`;
  await publishProfile({ profileId: a.id, source: "schedule", title: "read me", body: "body", dedupeKey });
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get(a.id, dedupeKey) as { id: number };
  db.prepare(
    "INSERT INTO profile_notification_reads(profile_id, notification_id, read_at) VALUES(?, ?, ?)",
  ).run(a.id, notification.id, "2099-12-03T00:00:00.000Z");

  deleteSchedule(a, item.id);

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM schedules WHERE profile_id = ? AND id = ?").get(a.id, item.id) as { count: number }).count,
    0,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?").get(a.id, dedupeKey) as { count: number }).count,
    1,
  );
  const delivery = db.prepare(
    "SELECT status FROM profile_notification_deliveries WHERE profile_id = ? AND notification_id = ?",
  ).get(a.id, notification.id) as { status: string };
  assert.equal(delivery.status, "cancelled");
});

test("S2: exhausted ordinary RRule schedules are created and updated as completed instead of active zombies", () => {
  const a = requireProfileContext("profile-a");
  const created = createSchedule(a, {
    title: "exhausted daily create",
    calendar: "solar",
    date: "2020-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "daily", until: "2020-01-10" },
  });
  assert.equal(created.status, "completed");
  assert.equal(created.enabled, false);
  assert.equal(created.nextRunAt, undefined);

  const active = createSchedule(a, {
    title: "exhausted daily update",
    calendar: "solar",
    date: "2099-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    recurrence: "daily",
  });
  assert.equal(active.status, "active");
  assert.equal(active.enabled, true);
  const updated = updateSchedule(a, active.id, {
    recurrence: { frequency: "daily", until: "2020-01-10" },
  });
  assert.equal(updated.status, "completed");
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextRunAt, undefined);

  const rowFor = (id: string) => db.prepare(
    "SELECT status, enabled, next_run_at FROM schedules WHERE profile_id = ? AND id = ?",
  ).get(a.id, id) as Record<string, unknown>;
  assert.deepEqual({ ...rowFor(created.id) }, { status: "completed", enabled: 0, next_run_at: null });
  assert.deepEqual({ ...rowFor(active.id) }, { status: "completed", enabled: 0, next_run_at: null });
  db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id IN (?, ?)").run(a.id, created.id, active.id);
});

test("S5: read hydration reports an invalid next_run_at without writing", () => {
  const a = requireProfileContext("profile-a");
  const stamp = "2099-01-01T00:00:00.000Z";
  db.prepare(`
    INSERT INTO schedules(profile_id, id, type, title, priority, status, calendar, date, time, all_day, timezone, recurrence_json, reminders_json, enabled, next_run_at, version, created_at, updated_at)
    VALUES(?, 'bad-next-run-repair', 'todo', 'bad next run repair', 'normal', 'active', 'solar', '2099-01-02', '09:00', 1, 'Asia/Shanghai',
      '{"frequency":"daily","interval":1,"calendar":"solar"}',
      '[{"minutesBefore":0,"id":"reminder-1","target":"occurrence"}]', 1, 'not-a-date', 1, ?, ?)
  `).run(a.id, stamp, stamp);
  // 只读 hydration 不写库，但必须经 logHydrationError 留痕。
  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const item = getSchedule(a, "bad-next-run-repair");
    assert.equal(item.nextRunAt, undefined);
    const row = db.prepare(
      "SELECT next_run_at, enabled FROM schedules WHERE profile_id = ? AND id = ?",
    ).get(a.id, "bad-next-run-repair") as Record<string, unknown>;
    assert.deepEqual({ ...row }, { next_run_at: "not-a-date", enabled: 1 });
    assert.ok(
      errors.some((line) => line.includes("hydration") && line.includes("bad-next-run-repair")),
      `S5 自愈必须记录日志，实际记录：${JSON.stringify(errors)}`,
    );
  } finally {
    console.error = originalConsoleError;
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, "bad-next-run-repair");
  }
});

test("updating a schedule with a NULL legacy version self-heals", () => {
  // N2：version=NULL 时 UPDATE 的 WHERE 必须用 version IS ?（SQLite 的 IS 匹配 NULL），
  // 写回归一化值自愈，否则永远冲突。schema 为 NOT NULL，测试用 CTAS 重建表
  // （CTAS 不保留 NOT NULL 约束）模拟外部写入的 NULL 损坏；本测试为文件末尾测试。
  const a = requireProfileContext("profile-a");
  const item = createSchedule(a, {
    title: "null version",
    calendar: "solar",
    date: "2099-01-02",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  try {
    db.exec(`
      CREATE TABLE schedules_nullable AS SELECT * FROM schedules;
      DROP TABLE schedules;
      ALTER TABLE schedules_nullable RENAME TO schedules;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_pk_recreated ON schedules(profile_id, id);
    `);
    db.prepare("UPDATE schedules SET version = NULL WHERE profile_id = ? AND id = ?").run(a.id, item.id);
    const updated = updateSchedule(a, item.id, { title: "null version renamed" });
    assert.equal(updated.title, "null version renamed");
    const row = db.prepare("SELECT version FROM schedules WHERE profile_id = ? AND id = ?")
      .get(a.id, item.id) as { version: number };
    assert.equal(row.version, 2, "写回应自愈为归一化值+1");
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(a.id, item.id);
  }
});

test("M7: lease refresh failures are contained and never crash the heartbeat", async (t) => {
  // 真实 SQLITE_BUSY 难以在单测复现：打桩续租 UPDATE 抛错，用假时钟推进 60s 触发心跳，
  // 断言 fence 的 catch 分支（console.error + 返回 false）让进程存活，而不是未捕获冒泡终止。
  // startScheduler 会触发 holiday onStart 抓取：预先写入冷却标记，让刷新在抓取前直接失败。
  const now = new Date().toISOString();
  for (const year of [new Date().getFullYear(), new Date().getFullYear() + 1]) {
    db.prepare(`
      INSERT INTO cn_holiday_year_meta(year, status, source, payload_hash, fetched_at, last_attempt_at, last_error)
      VALUES(?, 'failed', 'none', '', ?, ?, 'offline: M7 forced cooldown')
      ON CONFLICT(year) DO UPDATE SET
        status = 'failed', source = 'none', payload_hash = '', fetched_at = excluded.fetched_at,
        last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error
    `).run(year, now, now);
  }

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  const startScheduler = (schedulerModule as Record<string, unknown>).startScheduler as () => {
    stop(): void;
    owner: string;
    started: boolean;
  };
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let handle: { stop(): void; started: boolean } | undefined;
  try {
    // 先以真实 db 获取租约并启动（onStart 的 runFenced/fence 同步返回成功）。
    handle = startScheduler();
    assert.equal(handle.started, true);

    // 再打桩续租 UPDATE 模拟 SQLITE_BUSY；心跳回调里的 fence 必须吞掉错误。
    const originalPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (String(sql).includes("UPDATE scheduler_lease")) {
        return {
          run: () => { throw new Error("SQLITE_BUSY: database is locked"); },
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;
    try {
      t.mock.timers.tick(60_000); // 触发 60s 心跳 → fence → 续租抛错被吞、进程不退出
      assert.ok(
        errors.some((line) => line.includes("lease refresh failed")),
        `fence 必须记录续租失败而不是未捕获冒泡: ${errors.join(" | ")}`,
      );
      assert.ok(
        !errors.some((line) => line.includes("lease lost")),
        "瞬态续租失败不应被误判为租约丢失而停表",
      );
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
  } finally {
    handle?.stop();
    t.mock.timers.reset();
    console.error = originalError;
  }
});

test("schedule.list validates from/to as ISO dates instead of silently comparing garbage", async () => {
  // L4：from/to 曾是 z.string() 透传，与 next_run_at 做字典序比较——垃圾输入静默空结果。
  // 现在 schema 层校验，非法参数经工具面返回 isError 而不是空列表。
  const { getModules } = await import("../src/core/registry.js");
  await import("../src/modules/schedule/index.js");
  const scheduleModule = getModules().find((module) => module.name === "schedule");
  assert.ok(scheduleModule, "schedule 模块应已注册");
  const listTool = scheduleModule.tools.find((tool) => tool.name === "list");
  assert.ok(listTool, "schedule.list 工具应存在");
  const a = requireProfileContext("profile-a");

  const badFrom = await listTool.handler({ from: "garbage" }, a);
  assert.equal(badFrom.isError, true, "垃圾 from 必须参数报错，而不是静默空结果");
  assert.match(String(badFrom.content?.[0]?.text ?? ""), /from 必须是/);

  const badTo = await listTool.handler({ to: "not-a-date" }, a);
  assert.equal(badTo.isError, true);

  const good = await listTool.handler({ from: "2026-08-29", to: "2099-12-31T23:59:59.999Z" }, a);
  assert.notEqual(good.isError, true, "合法 ISO 日期/UTC 时间应通过校验");
});
