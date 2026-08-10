import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 阶段 C：发布层接线测试（C3 红 → C4 绿）。
// 必须在导入 src 模块前设置环境：notifier/config 在模块加载时解析
// PROFILE_PUSH_ROUTES_JSON。profile-a 配 qq-markdown、profile-b 走老 JSON
// （无 renderTarget），用于验证「按 Profile 分别渲染」与「缺省 → plain」。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-publisher-test-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";
process.env.PROFILE_PUSH_ROUTES_JSON = JSON.stringify({
  "profile-a": {
    route: "qqbot-a",
    url: "http://127.0.0.1:8701/webhooks/profile-a",
    secret: crypto.createHash("sha256").update("publisher profile-a fixture").digest("hex"),
    renderTarget: "qq-markdown",
  },
  "profile-b": {
    route: "qqbot-b",
    url: "http://127.0.0.1:8702/webhooks/profile-b",
    secret: crypto.createHash("sha256").update("publisher profile-b fixture").digest("hex"),
  },
});

const { publishNotification } = await import("../src/core/notification-publisher.js");
const { getDatabase } = await import("../src/core/database.js");
const db = getDatabase();

import type { NotificationEnvelope } from "../src/core/notification.js";

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the semantic bridge renders before using the existing global publish contract", async () => {
  const calls: Array<{ source: string; title: string; body: string; dedupeKey?: string }> = [];
  const notification: NotificationEnvelope = {
    kind: "weather.daily_brief",
    identity: "daily-brief:2026-08-04",
    source: "weather",
    scope: { type: "global" },
    headline: "萍乡今天晴，最高33℃",
    generatedAt: "2026-08-04T07:00:00+08:00",
    payload: {
      city: "萍乡",
      today: { weather: "晴", minTemperatureC: 25, maxTemperatureC: 33 },
    },
  };

  await publishNotification(notification, {
    publishGlobal: async (source, title, body, dedupeKey) => {
      calls.push({ source, title, body, dedupeKey });
    },
  });

  assert.deepEqual(calls, [{
    source: "weather",
    title: "萍乡今天晴，最高33℃",
    body: "今日：25～33℃，晴",
    dedupeKey: "weather:daily-brief:2026-08-04",
  }]);
});

test("the semantic bridge accepts a render target and snapshots an injected renderer result", async () => {
  const calls: Array<{ profileId: string; source: string; title: string; body: string; dedupeKey: string }> = [];
  let renderCalls = 0;
  const notification: NotificationEnvelope = {
    kind: "schedule.reminder",
    identity: "profile-a:schedule-42:occurrence-1",
    source: "schedule",
    scope: { type: "profile", profileId: "profile-a" },
    headline: "Legacy title",
    generatedAt: "2026-08-07T00:00:00.000Z",
    payload: {
      title: "Legacy title",
      eventAt: "2026-08-10T01:30:00.000Z",
      timezone: "Asia/Shanghai",
      reminderMinutes: 0,
    },
  };

  await publishNotification(notification, {
    renderTarget: "qq-markdown",
    renderer: (received, target) => {
      renderCalls += 1;
      assert.strictEqual(received, notification);
      assert.equal(target, "qq-markdown");
      return { title: "Rendered once", body: "Stored snapshot" };
    },
    publishProfile: async (profileId, source, title, body, dedupeKey) => {
      calls.push({ profileId, source, title, body, dedupeKey });
    },
  });

  assert.equal(renderCalls, 1);
  assert.deepEqual(calls, [{
    profileId: "profile-a",
    source: "schedule",
    title: "Rendered once",
    body: "Stored snapshot",
    dedupeKey: "schedule:profile-a:schedule-42:occurrence-1",
  }]);
});

// ============================================================================
// 阶段 C：renderTarget 解析 → 发布链路接线
// ============================================================================

const dailyBrief = (identity: string, scope: NotificationEnvelope["scope"], generatedAt = "2026-08-04T07:00:00+08:00"): NotificationEnvelope => ({
  kind: "weather.daily_brief",
  identity,
  source: "weather",
  scope,
  headline: "萍乡今天晴，最高33℃",
  generatedAt,
  payload: {
    city: "萍乡",
    today: { weather: "晴", minTemperatureC: 25, maxTemperatureC: 33 },
  },
});

test("profile-scoped notifications render with the profile's configured renderTarget", async () => {
  const calls: Array<{ profileId: string; source: string; title: string; body: string; dedupeKey: string }> = [];

  await publishNotification(dailyBrief("profile-a:daily-1", { type: "profile", profileId: "profile-a" }), {
    publishProfile: async (profileId, source, title, body, dedupeKey) => {
      calls.push({ profileId, source, title, body, dedupeKey });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileId, "profile-a");
  assert.equal(calls[0].title, "# 萍乡今天晴，最高33℃");
  assert.equal(calls[0].body, "**今日**：25～33℃，晴");
});

test("a global event fans out with each profile's own rendered title/body", async () => {
  await publishNotification(dailyBrief("daily-brief:2026-08-05", { type: "global" }, "2026-08-05T07:00:00+08:00"));

  const rows = db.prepare(`
    SELECT profile_id, title, body FROM profile_notifications
    WHERE dedupe_key = ? ORDER BY profile_id
  `).all("weather:daily-brief:2026-08-05") as Array<Record<string, unknown>>;

  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { profile_id: "profile-a", title: "# 萍乡今天晴，最高33℃", body: "**今日**：25～33℃，晴" },
    { profile_id: "profile-b", title: "萍乡今天晴，最高33℃", body: "今日：25～33℃，晴" },
  ]);
});

test("routes without renderTarget resolve to plain when no renderer or target is provided", async () => {
  const calls: Array<{ profileId: string; source: string; title: string; body: string; dedupeKey: string }> = [];

  await publishNotification(dailyBrief("profile-b:daily-1", { type: "profile", profileId: "profile-b" }), {
    publishProfile: async (profileId, source, title, body, dedupeKey) => {
      calls.push({ profileId, source, title, body, dedupeKey });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileId, "profile-b");
  assert.equal(calls[0].title, "萍乡今天晴，最高33℃");
  assert.equal(calls[0].body, "今日：25～33℃，晴");
});
