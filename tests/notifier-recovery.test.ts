import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 修复回归：P1-05 route 同名恢复后 fallback 重新入队；P1-06 notify 二参形式。
// 必须在导入 src 模块前设置环境。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-notifier-recovery-"));
const testSecret = crypto.createHash("sha256").update("notifier recovery fixture").digest("hex");
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";
process.env.PROFILE_PUSH_ROUTES_JSON = JSON.stringify({
  "profile-a": {
    route: "qqbot",
    url: "http://127.0.0.1:8644/webhooks/life-assistant-reminder",
    secret: testSecret,
  },
});

const notifierModule = await import("../src/core/notifier.js");
const { notify, publishProfile, pullPending } = notifierModule;
const deliverPendingProfileNotifications = (notifierModule as Record<string, unknown>).deliverPendingProfileNotifications as (
  options: { at?: Date; profileId?: string; fetchImpl: typeof fetch; clock?: () => Date },
) => Promise<{ attempted: number; sent: number; failed: number }>;
const { getDatabase } = await import("../src/core/database.js");
const db = getDatabase();
const configModule = await import("../src/config.js");
const routes = (configModule.config as { profilePushRoutes: Record<string, { route: string; url: string; secret: string }> }).profilePushRoutes;
const { requireProfileContext } = await import("../src/core/profile.js");

const successFetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;

/** 取消此前测试遗留的 delivery 行，避免串扰。 */
function clearDeliveries(): void {
  db.prepare("UPDATE profile_notification_deliveries SET status = 'cancelled'").run();
}

function deliveryRow(dedupeKey: string): Record<string, unknown> {
  return db.prepare(`
    SELECT d.status, d.attempts, d.last_error, d.route, d.request_generation,
           d.transport_failures, d.next_attempt_at, d.claimed_at
    FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE n.dedupe_key = ? AND n.profile_id = ?
  `).get(dedupeKey, "profile-a") as Record<string, unknown>;
}

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("notify without a dedupe key publishes title and body verbatim", async () => {
  await notify("二参标题", "二参正文");
  const row = db.prepare(`
    SELECT source, title, body, dedupe_key FROM profile_notifications
    WHERE profile_id = ? AND title = ?
  `).get("profile-a", "二参标题") as Record<string, unknown>;
  assert.equal(row.source, "general");
  assert.equal(row.body, "二参正文");
  assert.equal(row.dedupe_key, null);
});

test("fallback deliveries re-enter the queue when the same route is restored", async () => {
  clearDeliveries();
  await publishProfile("profile-a", "schedule", "临时故障", "恢复后应送达", "recovery:same-route:1");

  // 模拟 route 配置瞬时缺失：delivery 进入 fallback（route missing）。
  const original = routes["profile-a"];
  delete routes["profile-a"];
  try {
    await deliverPendingProfileNotifications({
      at: new Date("2100-03-01T00:00:00.000Z"),
      profileId: "profile-a",
      fetchImpl: successFetch,
      clock: () => new Date("2100-03-01T00:00:00.000Z"),
    });
  } finally {
    routes["profile-a"] = original;
  }
  let row = deliveryRow("recovery:same-route:1");
  assert.equal(row.status, "fallback");

  // route 同名恢复：下一次 tick 重新入队并送达。
  let calls = 0;
  const summary = await deliverPendingProfileNotifications({
    at: new Date("2100-03-01T00:01:00.000Z"),
    profileId: "profile-a",
    fetchImpl: (async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
    clock: () => new Date("2100-03-01T00:01:00.000Z"),
  });
  assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(calls, 1);
  row = deliveryRow("recovery:same-route:1");
  assert.equal(row.status, "sent");
  assert.equal(row.last_error, null);
});

test("fallback rows caused by a route rename are re-activated when the original route returns", async () => {
  clearDeliveries();
  await publishProfile("profile-a", "schedule", "改名恢复", "改名恢复正文", "recovery:renamed:1");
  const original = routes["profile-a"];
  routes["profile-a"] = {
    route: "renamed-route",
    url: "http://127.0.0.1:8644/webhooks/renamed",
    secret: testSecret,
  };
  try {
    // route 改名：旧 qqbot 行 → fallback（route changed），新 renamed-route 行 → pending。
    await publishProfile("profile-a", "schedule", "改名恢复", "改名恢复正文", "recovery:renamed:1");
  } finally {
    routes["profile-a"] = original;
  }

  // 恢复原 route 后的单次 tick：renamed-route 行被标记 fallback（route missing），
  // qqbot 行（route changed）重新入队并同一 tick 送达。
  const summary = await deliverPendingProfileNotifications({
    at: new Date("2100-03-02T00:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: successFetch,
    clock: () => new Date("2100-03-02T00:00:00.000Z"),
  });
  assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0 });
  const rows = db.prepare(`
    SELECT d.route, d.status FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE n.dedupe_key = ? AND n.profile_id = ? ORDER BY d.route
  `).all("recovery:renamed:1", "profile-a") as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => ({ route: row.route, status: row.status })), [
    { route: "qqbot", status: "sent" },
    { route: "renamed-route", status: "fallback" },
  ]);
});

test("fallback rows already pulled by notify.pull are not re-delivered", async () => {
  clearDeliveries();
  await publishProfile("profile-a", "schedule", "拉取兜底", "已经拉取", "recovery:pulled:1");
  const original = routes["profile-a"];
  delete routes["profile-a"];
  try {
    await deliverPendingProfileNotifications({
      at: new Date("2100-03-03T00:00:00.000Z"),
      profileId: "profile-a",
      fetchImpl: successFetch,
      clock: () => new Date("2100-03-03T00:00:00.000Z"),
    });
  } finally {
    routes["profile-a"] = original;
  }
  assert.equal(deliveryRow("recovery:pulled:1").status, "fallback");

  // 用户先通过 pull 取走：read 标记 + delivery 取消，route 恢复后不得再推。
  const pulled = pullPending(requireProfileContext("profile-a"));
  assert.equal(pulled.some((notice) => notice.title === "拉取兜底"), true);

  const summary = await deliverPendingProfileNotifications({
    at: new Date("2100-03-03T00:01:00.000Z"),
    profileId: "profile-a",
    fetchImpl: successFetch,
    clock: () => new Date("2100-03-03T00:01:00.000Z"),
  });
  assert.deepEqual(summary, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(deliveryRow("recovery:pulled:1").status, "cancelled");
});

test("transport-failure fallbacks stay terminal after route recovery", async () => {
  clearDeliveries();
  await publishProfile("profile-a", "schedule", "传输失败", "不确定结果", "recovery:transport:1");
  const at = new Date("2100-03-04T00:00:00.000Z");
  const times = [
    new Date("2100-03-04T00:00:00.000Z"),
    new Date("2100-03-04T00:01:01.000Z"),
    new Date("2100-03-04T00:06:02.000Z"),
  ];
  const timeoutFetch = (async () => {
    throw new TypeError("network timeout");
  }) as typeof fetch;
  for (const tick of times) {
    await deliverPendingProfileNotifications({
      at: tick,
      profileId: "profile-a",
      fetchImpl: timeoutFetch,
      clock: () => tick,
    });
  }
  assert.equal(deliveryRow("recovery:transport:1").status, "fallback");

  // route 配置自始至终存在：transport 类 fallback 不得被重新投递（幂等窗口风险）。
  const summary = await deliverPendingProfileNotifications({
    at: new Date("2100-03-04T00:10:00.000Z"),
    profileId: "profile-a",
    fetchImpl: successFetch,
    clock: () => at,
  });
  assert.deepEqual(summary, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(deliveryRow("recovery:transport:1").status, "fallback");
});

function setDeliverySending(dedupeKey: string, claimedAt: string): void {
  db.prepare(`
    UPDATE profile_notification_deliveries
    SET status = 'sending', claim_token = 'manual-claim', claimed_at = ?, updated_at = ?
    WHERE profile_id = 'profile-a'
      AND notification_id = (
        SELECT id FROM profile_notifications WHERE profile_id = 'profile-a' AND dedupe_key = ?
      )
  `).run(claimedAt, claimedAt, dedupeKey);
}

test("N1: pull read prevents redelivery of an in-flight sending row on a restored route", async () => {
  clearDeliveries();
  await publishProfile("profile-a", "schedule", "N1 in-flight", "N1 body", "recovery:n1:1");
  const original = routes["profile-a"];
  const claimedAt = "2100-04-01T00:00:00.000Z";
  setDeliverySending("recovery:n1:1", claimedAt);

  routes["profile-a"] = {
    route: "qqbot-2",
    url: "http://127.0.0.1:8644/webhooks/route-2",
    secret: testSecret,
  };
  try {
    const pulled = pullPending(requireProfileContext("profile-a"));
    assert.equal(pulled.some((notice) => notice.title === "N1 in-flight"), true);
  } finally {
    routes["profile-a"] = original;
  }
  assert.equal(deliveryRow("recovery:n1:1").status, "sending");

  let calls = 0;
  const at = new Date("2100-04-01T00:10:00.000Z");
  const summary = await deliverPendingProfileNotifications({
    at,
    profileId: "profile-a",
    fetchImpl: (async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
    clock: () => at,
  });
  assert.deepEqual(summary, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(calls, 0);
  assert.equal(deliveryRow("recovery:n1:1").status, "sending");
});

test("N2: idempotency-window fallback wins over route-missing fallback", async () => {
  clearDeliveries();
  await publishProfile("profile-a", "schedule", "N2 idempotency", "N2 body", "recovery:n2:1");
  const original = routes["profile-a"];
  const t0 = new Date("2100-05-01T00:00:00.000Z");
  const timeoutFetch = (async () => {
    throw new TypeError("network timeout");
  }) as typeof fetch;

  await deliverPendingProfileNotifications({
    at: t0,
    profileId: "profile-a",
    fetchImpl: timeoutFetch,
    clock: () => t0,
  });
  assert.equal(deliveryRow("recovery:n2:1").status, "failed");

  const t1 = new Date("2100-05-01T01:00:00.000Z");
  delete routes["profile-a"];
  try {
    await deliverPendingProfileNotifications({
      at: t1,
      profileId: "profile-a",
      fetchImpl: successFetch,
      clock: () => t1,
    });
  } finally {
    routes["profile-a"] = original;
  }

  const row = deliveryRow("recovery:n2:1");
  assert.equal(row.status, "fallback");
  assert.equal(row.last_error, "uncertain delivery exceeded webhook idempotency window");

  const t2 = new Date("2100-05-01T01:05:00.000Z");
  const summary = await deliverPendingProfileNotifications({
    at: t2,
    profileId: "profile-a",
    fetchImpl: successFetch,
    clock: () => t2,
  });
  assert.deepEqual(summary, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(deliveryRow("recovery:n2:1").status, "fallback");
});

test("N3: pullPending returns zombie sending claims older than two minutes", async () => {
  clearDeliveries();
  await publishProfile("profile-a", "schedule", "N3 zombie", "N3 zombie body", "recovery:n3:zombie");
  await publishProfile("profile-a", "schedule", "N3 fresh", "N3 fresh body", "recovery:n3:fresh");
  setDeliverySending("recovery:n3:zombie", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  setDeliverySending("recovery:n3:fresh", new Date().toISOString());

  const pulled = pullPending(requireProfileContext("profile-a"));
  assert.equal(pulled.some((notice) => notice.title === "N3 zombie"), true);
  assert.equal(pulled.some((notice) => notice.title === "N3 fresh"), false);
});

test("N4: due deliveries are attempted with bounded concurrency", async () => {
  clearDeliveries();
  for (let i = 1; i <= 5; i += 1) {
    await publishProfile("profile-a", "schedule", `N4 concurrent ${i}`, `N4 body ${i}`, `recovery:n4:${i}`);
  }
  let active = 0;
  let maxActive = 0;
  const fetchImpl = (async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    active -= 1;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const at = new Date("2100-06-01T00:00:00.000Z");
  const summary = await deliverPendingProfileNotifications({
    at,
    profileId: "profile-a",
    fetchImpl,
    clock: () => at,
  });
  assert.equal(maxActive, 5);
  assert.deepEqual(summary, { attempted: 5, sent: 5, failed: 0 });
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(deliveryRow(`recovery:n4:${i}`).status, "sent");
  }
});

test("N8: 3xx is treated as a confirmed HTTP failure via redirect manual", async () => {
  clearDeliveries();
  await publishProfile("profile-a", "schedule", "N8 redirect", "N8 body", "recovery:n8:1");
  let redirectMode: string | undefined;
  const redirectFetch = (async (_input: unknown, init?: { redirect?: string }) => {
    redirectMode = init?.redirect;
    return new Response("redirecting", { status: 302, headers: { Location: "http://127.0.0.1:1/elsewhere" } });
  }) as typeof fetch;

  const t0 = new Date("2100-07-01T00:00:00.000Z");
  for (const offset of [0, 61, 362, 1263, 4864]) {
    const at = new Date(t0.getTime() + offset * 1000);
    await deliverPendingProfileNotifications({ at, profileId: "profile-a", fetchImpl: redirectFetch, clock: () => at });
  }

  assert.equal(redirectMode, "manual");
  const row = deliveryRow("recovery:n8:1");
  assert.equal(row.status, "fallback");
  assert.equal(row.attempts, 5);
  assert.equal(row.request_generation, 6);
  assert.equal(row.transport_failures, 0);

  const at6 = new Date(t0.getTime() + 4865 * 1000);
  const summary = await deliverPendingProfileNotifications({ at: at6, profileId: "profile-a", fetchImpl: redirectFetch, clock: () => at6 });
  assert.deepEqual(summary, { attempted: 0, sent: 0, failed: 0 });
  assert.equal(deliveryRow("recovery:n8:1").status, "fallback");
});
