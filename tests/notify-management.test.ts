import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NotificationEnvelope } from "../src/core/notification.js";

// F1：静默时段 + snooze/cancel/list 通知管理。
// 必须在导入 src 模块前设置环境：config 在模块加载时解析 PROFILE_PUSH_ROUTES_JSON。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-notify-mgmt-"));
const testSecret = crypto.createHash("sha256").update("notify management fixture").digest("hex");
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";
process.env.PROFILE_PUSH_ROUTES_JSON = JSON.stringify({
  "profile-a": {
    route: "qqbot",
    url: "http://127.0.0.1:8645/webhooks/life-assistant",
    secret: testSecret,
  },
});

const {
  publishProfile,
  deliverPendingProfileNotifications,
  snoozeProfileNotificationDelivery,
  cancelProfileNotificationDelivery,
  listProfileNotifications,
} = await import("../src/core/notifier.js");
// schedule.reminder 的投递期重渲染钩子由模块 notification 文件注册；
// 生产进程经 modules/index 全量加载，直连单元测试需显式引入同一模块。
await import("../src/modules/schedule/notification.js");
const { pullPending } = await import("../src/core/notifier.js");
const {
  isQuietAt,
  saveQuietHours,
  clearQuietHours,
  getQuietHours,
} = await import("../src/core/notification-settings.js");
const { notifyModule } = await import("../src/core/notify-module.js");
const { getDatabase } = await import("../src/core/database.js");
const { publishNotification } = await import("../src/core/notification-publisher.js");
const { renderDeliveredNotification } = await import("../src/core/delivery-render.js");
const db = getDatabase();

const successFetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
const countingFetch = (calls: Array<{ url: string }>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

function notificationIdFor(dedupeKey: string): number {
  const row = db.prepare(
    "SELECT id FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
  ).get("profile-a", dedupeKey) as { id: number } | undefined;
  assert.ok(row, `notification ${dedupeKey} should exist`);
  return row.id;
}

function deliveryStatus(dedupeKey: string): string | undefined {
  const row = db.prepare(`
    SELECT d.status FROM profile_notification_deliveries d
    JOIN profile_notifications n ON n.id = d.notification_id AND n.profile_id = d.profile_id
    WHERE n.profile_id = ? AND n.dedupe_key = ?
  `).get("profile-a", dedupeKey) as { status: string } | undefined;
  return row?.status;
}

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("isQuietAt handles same-day, cross-midnight and until-midnight windows", () => {
  const quiet = { start: "22:00", end: "07:00", timezone: "UTC" };
  assert.equal(isQuietAt(quiet, new Date("2027-01-01T23:30:00Z")), true);
  assert.equal(isQuietAt(quiet, new Date("2027-01-01T03:00:00Z")), true);
  assert.equal(isQuietAt(quiet, new Date("2027-01-01T22:00:00Z")), true); // 含 start
  assert.equal(isQuietAt(quiet, new Date("2027-01-01T07:00:00Z")), false); // 不含 end
  assert.equal(isQuietAt(quiet, new Date("2027-01-01T12:00:00Z")), false);

  const sameDay = { start: "11:00", end: "13:00", timezone: "UTC" };
  assert.equal(isQuietAt(sameDay, new Date("2027-01-01T12:00:00Z")), true);
  assert.equal(isQuietAt(sameDay, new Date("2027-01-01T10:59:00Z")), false);
  assert.equal(isQuietAt(sameDay, new Date("2027-01-01T13:00:00Z")), false);

  const untilMidnight = { start: "20:00", end: "00:00", timezone: "UTC" };
  assert.equal(isQuietAt(untilMidnight, new Date("2027-01-01T23:59:00Z")), true);
  assert.equal(isQuietAt(untilMidnight, new Date("2027-01-01T00:01:00Z")), false);
});

test("deliveries are withheld during quiet hours and released after the window", async () => {
  clearQuietHours("profile-a");
  saveQuietHours("profile-a", "22:00", "07:00", "UTC");
  await publishProfile("profile-a", "schedule", "静默时段通知", "窗口内不应投递", "mgmt:quiet:1");

  const inWindow: Array<{ url: string }> = [];
  const duringQuiet = await deliverPendingProfileNotifications({
    at: new Date("2027-01-01T23:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: countingFetch(inWindow),
    clock: () => new Date("2027-01-01T23:00:00.000Z"),
  });
  assert.equal(duringQuiet.attempted, 0);
  assert.equal(inWindow.length, 0);
  assert.equal(deliveryStatus("mgmt:quiet:1"), "pending");

  const afterWindow: Array<{ url: string }> = [];
  const released = await deliverPendingProfileNotifications({
    at: new Date("2027-01-02T08:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: countingFetch(afterWindow),
    clock: () => new Date("2027-01-02T08:00:00.000Z"),
  });
  assert.equal(released.attempted, 1);
  assert.equal(released.sent, 1);
  assert.equal(afterWindow.length, 1);

  clearQuietHours("profile-a");
});

test("snooze defers the next delivery attempt until not_before passes", async () => {
  const at = new Date("2027-02-01T10:00:00.000Z");
  await publishProfile("profile-a", "schedule", "稍后提醒", "10 分钟后开会", "mgmt:snooze:1");
  const notificationId = notificationIdFor("mgmt:snooze:1");

  const snoozed = snoozeProfileNotificationDelivery("profile-a", notificationId, 30, at);
  assert.equal(snoozed.routes.length, 1);
  assert.equal(snoozed.snoozedUntil, "2027-02-01T10:30:00.000Z");

  const tooEarly: Array<{ url: string }> = [];
  const before = await deliverPendingProfileNotifications({
    at: new Date("2027-02-01T10:10:00.000Z"),
    profileId: "profile-a",
    fetchImpl: countingFetch(tooEarly),
    clock: () => new Date("2027-02-01T10:10:00.000Z"),
  });
  assert.equal(before.attempted, 0);
  assert.equal(tooEarly.length, 0);

  const due: Array<{ url: string }> = [];
  const after = await deliverPendingProfileNotifications({
    at: new Date("2027-02-01T10:31:00.000Z"),
    profileId: "profile-a",
    fetchImpl: countingFetch(due),
    clock: () => new Date("2027-02-01T10:31:00.000Z"),
  });
  assert.equal(after.attempted, 1);
  assert.equal(after.sent, 1);
});

test("snooze rejects uncertain in-flight failures within the idempotency window", async () => {
  await publishProfile("profile-a", "schedule", "不确定失败", "结果不确定时不能推迟", "mgmt:uncertain:1");
  const notificationId = notificationIdFor("mgmt:uncertain:1");
  db.prepare(`
    UPDATE profile_notification_deliveries
    SET status = 'failed', request_started_at = ?, attempts = 1
    WHERE profile_id = ? AND notification_id = ?
  `).run("2027-03-01T10:00:00.000Z", "profile-a", notificationId);

  assert.throws(
    () => snoozeProfileNotificationDelivery("profile-a", notificationId, 10, new Date("2027-03-01T10:20:00.000Z")),
    /不确定/,
  );

  // 幂等窗口之外的不确定失败可以推迟。
  const snoozed = snoozeProfileNotificationDelivery("profile-a", notificationId, 10, new Date("2027-03-01T11:00:00.000Z"));
  assert.equal(snoozed.snoozedUntil, "2027-03-01T11:10:00.000Z");
  assert.equal(deliveryStatus("mgmt:uncertain:1"), "pending");
});

test("snooze on a sent notification explains there is nothing to defer", async () => {
  await publishProfile("profile-a", "schedule", "已投递通知", "已送达", "mgmt:sent:1");
  const notificationId = notificationIdFor("mgmt:sent:1");
  await deliverPendingProfileNotifications({
    at: new Date("2027-04-01T09:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: successFetch,
    clock: () => new Date("2027-04-01T09:00:00.000Z"),
  });
  assert.equal(deliveryStatus("mgmt:sent:1"), "sent");
  assert.throws(
    () => snoozeProfileNotificationDelivery("profile-a", notificationId, 10),
    /没有可推迟的投递/,
  );
});

test("cancel stops pending delivery and keeps the notification out of notify.pull", async () => {
  await publishProfile("profile-a", "schedule", "取消投递", "用户不需要这条提醒", "mgmt:cancel:1");
  const notificationId = notificationIdFor("mgmt:cancel:1");

  const cancelled = cancelProfileNotificationDelivery("profile-a", notificationId);
  assert.equal(cancelled.cancelled, 1);
  assert.equal(deliveryStatus("mgmt:cancel:1"), "cancelled");

  const attempts: Array<{ url: string }> = [];
  const summary = await deliverPendingProfileNotifications({
    at: new Date("2027-05-01T09:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: countingFetch(attempts),
    clock: () => new Date("2027-05-01T09:00:00.000Z"),
  });
  assert.equal(summary.attempted, 0);
  assert.equal(attempts.length, 0);

  const pulled = pullPending("profile-a").filter((notice) => notice.dedupeKey === "mgmt:cancel:1");
  assert.equal(pulled.length, 0, "cancelled notification should not resurface via notify.pull");

  // 已终态的行再次取消是幂等的 no-op。
  const repeat = cancelProfileNotificationDelivery("profile-a", notificationId);
  assert.equal(repeat.cancelled, 0);
});

test("cancel rejects a notification that does not exist or belongs to another profile", () => {
  assert.throws(
    () => cancelProfileNotificationDelivery("profile-a", 999_999),
    /不存在或不属于当前 Profile/,
  );
});

test("listProfileNotifications returns recent entries with delivery status", async () => {
  await publishProfile("profile-a", "schedule", "列表通知A", "正文A", "mgmt:list:a");
  await publishProfile("profile-a", "schedule", "列表通知B", "正文B", "mgmt:list:b");
  await deliverPendingProfileNotifications({
    at: new Date("2027-06-01T09:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: successFetch,
    clock: () => new Date("2027-06-01T09:00:00.000Z"),
  });

  const entries = listProfileNotifications("profile-a", 2);
  assert.equal(entries.length, 2);
  // id 倒序：最新（B）在前。
  assert.equal(entries[0].title, "列表通知B");
  assert.equal(entries[0].deliveries.length, 1);
  assert.equal(entries[0].deliveries[0].route, "qqbot");
  assert.equal(entries[0].deliveries[0].status, "sent");
  assert.ok(entries[0].readAt, "sent notification should be marked read");
  assert.equal(entries[1].deliveries[0].status, "sent");
});

test("notify.quiet_hours tool round-trips set, get and clear", async () => {
  const tool = notifyModule.tools!.find((entry) => entry.name === "quiet_hours")!;
  const context = { id: "profile-a" };

  const current = await tool.handler({}, context);
  const currentPayload = JSON.parse((current.content[0] as { text: string }).text) as { quietHours: unknown };
  assert.equal(currentPayload.quietHours, null);

  const saved = await tool.handler({ start: "23:00", end: "06:30", timezone: "UTC" }, context);
  const savedPayload = JSON.parse((saved.content[0] as { text: string }).text) as {
    status: string;
    quietHours: { start: string; end: string; timezone: string };
  };
  assert.equal(savedPayload.status, "saved");
  assert.deepEqual(savedPayload.quietHours, { start: "23:00", end: "06:30", timezone: "UTC" });
  assert.deepEqual(getQuietHours("profile-a"), { start: "23:00", end: "06:30", timezone: "UTC" });

  const invalid = await tool.handler({ start: "23:00" }, context);
  assert.equal(invalid.isError, true);

  const cleared = await tool.handler({ clear: true }, context);
  const clearedPayload = JSON.parse((cleared.content[0] as { text: string }).text) as { status: string };
  assert.equal(clearedPayload.status, "cleared");
  assert.equal(getQuietHours("profile-a"), null);
});

test("quiet hours in a non-UTC timezone evaluate against local wall clock", () => {
  // 北京时间 2027-07-01 06:00（= UTC 前一日 22:00）落在 22:30–07:00 (+08:00) 窗口内。
  const quiet = { start: "22:30", end: "07:00", timezone: "Asia/Shanghai" };
  assert.equal(isQuietAt(quiet, new Date("2027-06-30T22:00:00.000Z")), true);
  assert.equal(isQuietAt(quiet, new Date("2027-06-30T04:00:00.000Z")), false); // 北京 12:00，窗口外
});

// ---------------------------------------------------------------------------
// 方案 A：schedule.reminder 投递时重渲染（相对时间重算 + 顺延原因标注）
// ---------------------------------------------------------------------------

function scheduleReminderEnvelope(identity: string, at: string): NotificationEnvelope {
  return {
    kind: "schedule.reminder",
    identity,
    source: "schedule",
    scope: { type: "profile", profileId: "profile-a" },
    headline: `待办 · 发生提醒：${identity}`,
    generatedAt: at,
    payload: {
      title: identity,
      eventAt: at,
      occurrenceAt: at,
      targetAt: at,
      target: "occurrence",
      reminderId: "reminder-1",
      timezone: "UTC",
      reminderMinutes: 0,
      type: "todo",
      status: "active",
      priority: "normal",
      allDay: false,
      generatedAt: at,
    },
  };
}

const bodyCapturingFetch = (requests: Array<{ body: string }>): typeof fetch =>
  (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

const failingFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

/** 隔离本条通知：取消 profile-a 其他遗留的未完成投递，避免 summary/请求计数被污染。 */
function cancelOtherDeliveries(notificationId: number): void {
  db.prepare(`
    UPDATE profile_notification_deliveries SET status = 'cancelled'
    WHERE profile_id = 'profile-a' AND notification_id <> ? AND status IN ('pending', 'failed', 'fallback')
  `).run(notificationId);
}

test("quiet-deferred schedule reminder re-renders relative time with reason at delivery", async () => {
  clearQuietHours("profile-a");
  saveQuietHours("profile-a", "22:00", "07:00", "UTC");
  try {
    const firedAt = "2027-06-01T23:00:00.000Z"; // 静默窗口内触发
    await publishNotification(scheduleReminderEnvelope("mgmt:quiet-defer:1", firedAt));
    cancelOtherDeliveries(notificationIdFor("schedule:mgmt:quiet-defer:1"));

    // 落库快照按发布时刻渲染：显示"现在"（且被冻结）。
    const snapshot = db.prepare(
      "SELECT body, envelope FROM profile_notifications WHERE profile_id = ? AND dedupe_key = ?",
    ).get("profile-a", "schedule:mgmt:quiet-defer:1") as { body: string; envelope: string | null };
    assert.match(snapshot.body, /相对：现在/);
    assert.ok(snapshot.envelope, "结构化 envelope 应随快照落库");

    const duringQuiet = await deliverPendingProfileNotifications({
      at: new Date("2027-06-01T23:01:00.000Z"),
      profileId: "profile-a",
      fetchImpl: bodyCapturingFetch([]),
      clock: () => new Date("2027-06-01T23:01:00.000Z"),
    });
    assert.equal(duringQuiet.attempted, 0);

    const requests: Array<{ body: string }> = [];
    const released = await deliverPendingProfileNotifications({
      at: new Date("2027-06-02T08:00:00.000Z"),
      profileId: "profile-a",
      fetchImpl: bodyCapturingFetch(requests),
      clock: () => new Date("2027-06-02T08:00:00.000Z"),
    });
    assert.equal(released.sent, 1);
    const payload = JSON.parse(requests[0].body) as { notification: { body: string } };
    assert.match(
      payload.notification.body,
      /相对：已逾期 9 小时（勿扰时段顺延）/,
      "补推时应按投递时刻重算相对时间并标注原因",
    );
  } finally {
    clearQuietHours("profile-a");
  }
});

test("immediate delivery within tolerance keeps a punctual reminder at 现在", async () => {
  clearQuietHours("profile-a");
  await publishNotification(scheduleReminderEnvelope("mgmt:punctual:1", "2027-06-05T10:00:00.000Z"));
  cancelOtherDeliveries(notificationIdFor("schedule:mgmt:punctual:1"));

  const requests: Array<{ body: string }> = [];
  const summary = await deliverPendingProfileNotifications({
    at: new Date("2027-06-05T10:00:02.000Z"),
    profileId: "profile-a",
    fetchImpl: bodyCapturingFetch(requests),
    clock: () => new Date("2027-06-05T10:00:02.000Z"),
  });
  assert.equal(summary.sent, 1);
  const payload = JSON.parse(requests[0].body) as { notification: { body: string } };
  assert.match(payload.notification.body, /相对：现在/);
  assert.doesNotMatch(payload.notification.body, /已逾期/);
});

test("snoozed delivery appends the 稍后提醒 deferral reason", async () => {
  clearQuietHours("profile-a");
  await publishNotification(scheduleReminderEnvelope("mgmt:snooze-defer:1", "2027-06-10T09:00:00.000Z"));
  const notificationId = notificationIdFor("schedule:mgmt:snooze-defer:1");
  cancelOtherDeliveries(notificationId);
  snoozeProfileNotificationDelivery("profile-a", notificationId, 30, new Date("2027-06-10T09:00:00.000Z"));

  const requests: Array<{ body: string }> = [];
  const summary = await deliverPendingProfileNotifications({
    at: new Date("2027-06-10T09:30:00.000Z"),
    profileId: "profile-a",
    fetchImpl: bodyCapturingFetch(requests),
    clock: () => new Date("2027-06-10T09:30:00.000Z"),
  });
  assert.equal(summary.sent, 1);
  const payload = JSON.parse(requests[0].body) as { notification: { body: string } };
  assert.match(payload.notification.body, /相对：已逾期 30 分钟（稍后提醒）/);
});

test("retried delivery appends the 投递重试延迟 deferral reason", async () => {
  clearQuietHours("profile-a");
  await publishNotification(scheduleReminderEnvelope("mgmt:retry-defer:1", "2027-06-15T09:00:00.000Z"));
  cancelOtherDeliveries(notificationIdFor("schedule:mgmt:retry-defer:1"));

  const failed = await deliverPendingProfileNotifications({
    at: new Date("2027-06-15T09:00:00.000Z"),
    profileId: "profile-a",
    fetchImpl: failingFetch,
    clock: () => new Date("2027-06-15T09:00:00.000Z"),
  });
  assert.equal(failed.failed, 1);

  const requests: Array<{ body: string }> = [];
  const retried = await deliverPendingProfileNotifications({
    at: new Date("2027-06-15T09:05:00.000Z"),
    profileId: "profile-a",
    fetchImpl: bodyCapturingFetch(requests),
    clock: () => new Date("2027-06-15T09:05:00.000Z"),
  });
  assert.equal(retried.sent, 1);
  const payload = JSON.parse(requests[0].body) as { notification: { body: string } };
  assert.match(payload.notification.body, /相对：已逾期 5 分钟（投递重试延迟）/);
});

test("notify.pull re-renders quiet-deferred schedule reminders at pull time", async () => {
  clearQuietHours("profile-a");
  saveQuietHours("profile-a", "22:00", "07:00", "UTC");
  try {
    await publishNotification(scheduleReminderEnvelope("mgmt:pull-defer:1", "2027-06-20T23:00:00.000Z"));
    const pulled = pullPending("profile-a", new Date("2027-06-21T08:00:00.000Z"));
    const target = pulled.find((notice) => notice.dedupeKey === "schedule:mgmt:pull-defer:1");
    assert.ok(target, "顺延中的提醒应可被拉取");
    assert.match(target.body, /相对：已逾期 9 小时（勿扰时段顺延）/);
  } finally {
    clearQuietHours("profile-a");
  }
});

test("renderDeliveredNotification falls back to the stored snapshot without a usable envelope", () => {
  const snapshot = { title: "快照标题", body: "快照正文" };
  assert.deepEqual(
    renderDeliveredNotification({ profileId: "profile-a", ...snapshot, envelope: null }, new Date()),
    snapshot,
  );
  assert.deepEqual(
    renderDeliveredNotification({ profileId: "profile-a", ...snapshot, envelope: "{not json" }, new Date()),
    snapshot,
  );
});
