import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Lunar, Solar } from "lunar-javascript";

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

const { requireProfileContext } = await import("../src/core/profile.js");
const configModule = await import("../src/config.js");
const parseProfilePushRoutes = (configModule as Record<string, unknown>).parseProfilePushRoutes as (
  raw?: string,
) => Record<string, { route: string; url: string; secret: string }>;
const { createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule } = await import(
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
const { runDueSchedules, acquireSchedulerLease, refreshSchedulerLease, releaseSchedulerLease } = schedulerModule;
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
  getOilPrice: () => Promise<{ region: string; p92: string; p95: string; p0: string }>;
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
  assert.deepEqual(Object.keys(routes).sort(), ["constructor", "default"]);
  assert.equal(routes["constructor"].secret, strongB);
});

test("Profile context is required and never falls back to default", () => {
  delete process.env.HERMES_PROFILE;
  assert.throws(() => requireProfileContext(), /HERMES_PROFILE/);
  process.env.HERMES_PROFILE = "profile-a";
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
  await publishGlobal("weather", "shared alert", "global:test:1");
  const a = pullPending(requireProfileContext("profile-a"));
  const b = pullPending(requireProfileContext("profile-b"));
  assert.equal(a.filter((n) => n.body === "shared alert").length, 1);
  assert.equal(b.filter((n) => n.body === "shared alert").length, 1);
  assert.equal(pullPending(requireProfileContext("profile-a")).some((n) => n.body === "shared alert"), false);
});

test("the two-argument global form preserves its resolved fields for every Profile", async () => {
  await publishGlobal("Two-argument title", "Two-argument body");

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
  await publishGlobal("weather", "Public alert", "shared active push", "global:push:once");
  await publishGlobal("weather", "Public alert", "shared active push", "global:push:once");

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

  await publishGlobal("weather", "Republished alert", "duplicate profile item", dedupeKey);

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

test("the deterministic daily brief publishes once per local date through every Profile route", async () => {
  assert.equal(typeof runDailyWeatherBrief, "function");
  const options = {
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "北京", lat: 39.9, lon: 116.4 }),
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
    getOilPrice: async () => ({ region: "北京", p92: "7.21", p95: "7.68", p0: "6.91" }),
  };

  await runDailyWeatherBrief({ ...options, at: new Date("2026-08-03T00:00:00.000Z") });
  await runDailyWeatherBrief({ ...options, at: new Date("2026-08-03T10:00:00.000Z") });

  const sameDay = db.prepare(`
    SELECT profile_id, title, body FROM profile_notifications
    WHERE dedupe_key = ? ORDER BY profile_id
  `).all("weather:daily-brief:2026-08-03") as Array<Record<string, unknown>>;
  assert.equal(sameDay.length, 2);
  assert.deepEqual(sameDay.map((row) => row.profile_id), ["profile-a", "profile-b"]);
  assert.match(String(sameDay[0].title), /北京.*生活简报/);
  assert.match(String(sameDay[0].body), /当前多云，28℃/);
  assert.match(String(sameDay[0].body), /今日阵雨，24~32℃，降水概率70%/);
  assert.match(String(sameDay[0].body), /92# 7.21元\/升/);
  assert.doesNotMatch(String(sameDay[0].body), /\|/);

  await runDailyWeatherBrief({ ...options, at: new Date("2026-08-04T00:00:00.000Z") });
  const allBriefs = db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notifications
    WHERE dedupe_key LIKE 'weather:daily-brief:%'
  `).get() as { count: number };
  assert.equal(allBriefs.count, 4);
});

test("the daily brief labels probability percent and precipitation amount millimeters distinctly", async () => {
  const bodies: string[] = [];
  const common = {
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "北京", lat: 39.9, lon: 116.4 }),
    getCurrent: async () => { throw new Error("current unavailable"); },
    getOilPrice: async () => { throw new Error("oil unavailable"); },
    publish: async (_source: string, _title: string, body: string) => {
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

  assert.match(bodies[0], /今日阵雨，23~30℃，降水概率65%/);
  assert.doesNotMatch(bodies[0], /预计降水/);
  assert.match(bodies[1], /今日中雨，22~29℃，预计降水12\.7mm/);
  assert.doesNotMatch(bodies[1], /降水概率|undefined%/);
});

test("the daily brief survives forecast and optional oil provider failures", async () => {
  const published: Array<{ source: string; title: string; body: string; dedupeKey: string }> = [];
  await runDailyWeatherBrief({
    at: new Date("2026-08-05T00:00:00.000Z"),
    timezone: "Asia/Shanghai",
    getLocation: () => ({ city: "上海", lat: 31.2, lon: 121.5 }),
    getCurrent: async () => ({
      temperature: 30,
      apparent: 33,
      humidity: 70,
      windSpeed: 8,
      windSpeedUnit: "km/h",
      weatherText: "晴",
    }),
    getForecast: async () => { throw new Error("forecast unavailable"); },
    getOilPrice: async () => { throw new Error("oil unavailable"); },
    publish: async (source, title, body, dedupeKey) => {
      published.push({ source, title, body, dedupeKey });
    },
  });

  assert.deepEqual(published, [{
    source: "weather",
    title: "早安，上海生活简报",
    body: "当前晴，30℃，体感33℃，湿度70%",
    dedupeKey: "weather:daily-brief:2026-08-05",
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
    getOilPrice: async () => ({ region: "广东", p92: "7.31", p95: "7.92", p0: "7.00" }),
    publish: async (source: string, title: string, body: string, dedupeKey: string) => {
      published.push({ source, title, body, dedupeKey });
    },
  };

  await assert.rejects(() => runDailyWeatherBrief(options), /daily weather brief providers failed/);
  assert.deepEqual(published, []);

  await runDailyWeatherBrief(options);
  assert.equal(published.length, 1);
  assert.equal(published[0].dedupeKey, "weather:daily-brief:2026-08-06");
  assert.match(published[0].body, /当前多云，31℃/);
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
  await publishProfile("profile-a", "schedule", "A only", "profile:test:a");
  const a = pullPending(requireProfileContext("profile-a"));
  const b = pullPending(requireProfileContext("profile-b"));
  assert.equal(a.some((n) => n.body === "A only"), true);
  assert.equal(b.some((n) => n.body === "A only"), false);
});

test("a Profile notification with no configured route remains in notify.pull", async () => {
  await publishProfile("profile-c", "schedule", "No route", "pull fallback", "profile:missing-route:1");
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
  await publishProfile("profile-a", "schedule", "QQ push", "private body", "push:test:a");
  await publishProfile("profile-a", "schedule", "QQ push", "private body", "push:test:a");
  await publishProfile("profile-c", "schedule", "queue only", "fallback body", "push:test:c");

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
  await publishProfile("profile-a", "schedule", "Delivered before route change", "do not resend", "push:sent-before-route-change");
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
    await publishProfile("profile-a", "schedule", "Delivered before route change", "do not resend", "push:sent-before-route-change");
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
  db.prepare("UPDATE profile_notification_deliveries SET status = 'cancelled'").run();
  for (let index = 0; index < 101; index += 1) {
    await publishProfile(
      "profile-a",
      "schedule",
      `Removed route ${index}`,
      "stale route",
      `push:removed-route:${index}`,
    );
  }
  db.prepare(`
    UPDATE profile_notification_deliveries
    SET route = 'removed-route', next_attempt_at = '2000-01-01T00:00:00.000Z'
    WHERE notification_id IN (
      SELECT id FROM profile_notifications WHERE dedupe_key LIKE 'push:removed-route:%'
    )
  `).run();
  await publishProfile("profile-a", "schedule", "Valid after stale batch", "must send", "push:valid-after-stale");

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
  await publishProfile("profile-b", "schedule", "Deliver me", "private body", "push:deliver:b");
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
  assert.equal(requests[0].init.redirect, "error");
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
  await publishProfile("profile-a", "schedule", "Batch one", "body one", "push:batch:1");
  await publishProfile("profile-a", "schedule", "Batch two", "body two", "push:batch:2");
  const ids = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key IN (?, ?) ORDER BY id",
  ).all("profile-a", "push:batch:1", "push:batch:2") as Array<{ id: number }>;
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE notification_id NOT IN (?, ?)",
  ).run(ids[0].id, ids[1].id);
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
  await publishProfile("profile-a", "schedule", "Retry me", "retry body", "push:retry:a");
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:retry:a") as { id: number };
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE NOT (profile_id = ? AND notification_id = ?)",
  ).run("profile-a", notification.id);

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
  await publishProfile("profile-b", "schedule", "HTTP retry", "fresh generation", "push:http-long-retry:b");
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:http-long-retry:b") as { id: number };
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE NOT (profile_id = ? AND notification_id = ?)",
  ).run("profile-b", notification.id);
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
  await publishProfile("profile-b", "schedule", "Bounded HTTP failure", "recover by pull", "push:http-bounded:b");
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:http-bounded:b") as { id: number };
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE NOT (profile_id = ? AND notification_id = ?)",
  ).run("profile-b", notification.id);
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
  await publishProfile("profile-b", "schedule", "Timeout me", "network uncertain", "push:timeout:b");
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:timeout:b") as { id: number };
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE NOT (profile_id = ? AND notification_id = ?)",
  ).run("profile-b", notification.id);

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
  await publishProfile("profile-b", "schedule", "Fallback me", "avoid late duplicate", "push:fallback:b");
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:fallback:b") as { id: number };
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE NOT (profile_id = ? AND notification_id = ?)",
  ).run("profile-b", notification.id);
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
  await publishProfile("profile-a", "schedule", "Old request", "must fall back", "push:old-request:a");
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:old-request:a") as { id: number };
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE NOT (profile_id = ? AND notification_id = ?)",
  ).run("profile-a", notification.id);
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
  await publishProfile("profile-a", "schedule", "Claim me", "single sender", "push:claim:a");
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:claim:a") as { id: number };
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE NOT (profile_id = ? AND notification_id = ?)",
  ).run("profile-a", notification.id);

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
  await publishProfile("profile-a", "schedule", "Already pushed", "do not repeat", "push:sent:a");
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
  await publishProfile("profile-a", "schedule", "Current route pending", "show once", "push:route-change:a");
  const notification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", "push:route-change:a") as { id: number };
  db.prepare("UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE notification_id <> ?")
    .run(notification.id);
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
  await publishProfile("profile-a", "schedule", "Historical route", "recover through pull", "push:no-current-route:a");
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
  await publishProfile("profile-b", "schedule", "Seen in chat", "cancel QQ duplicate", "push:pull:b");
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
  await publishProfile("profile-b", "schedule", "Existing outbox", "must still send", "push:existing:b");
  const existingNotification = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-b", "push:existing:b") as { id: number };
  db.prepare(
    "UPDATE profile_notification_deliveries SET status = 'cancelled' WHERE NOT (profile_id = ? AND notification_id = ?)",
  ).run("profile-b", existingNotification.id);

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
    WHEN NEW.title LIKE 'poison batch %'
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

test("schema v2 upgrades to a valid v3 delivery outbox", () => {
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
  assert.equal(version.value, "3");
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
