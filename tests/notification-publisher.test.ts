import assert from "node:assert/strict";
import test from "node:test";

import { publishNotification } from "../src/core/notification-publisher.js";
import type { NotificationEnvelope } from "../src/core/notification.js";

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
