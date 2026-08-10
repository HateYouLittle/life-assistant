import assert from "node:assert/strict";
import test from "node:test";

import {
  renderNotification,
  type NotificationRenderTarget,
} from "../src/core/notification.js";
import { buildScheduleReminderNotification } from "../src/modules/schedule/notification.js";
import type { ScheduleItem } from "../src/modules/schedule/types.js";

const item: ScheduleItem = {
  id: "schedule-42",
  profileId: "profile-a",
  type: "birthday",
  title: "妈妈生日",
  note: "提前订蛋糕",
  priority: "high",
  status: "active",
  calendar: "solar",
  date: "2026-08-10",
  time: "09:30",
  allDay: false,
  timezone: "Asia/Shanghai",
  recurrence: { frequency: "yearly", interval: 1, calendar: "solar" },
  reminders: [{ id: "week-before", minutesBefore: 10_080, target: "occurrence" }],
  deadlineOffsetMinutes: 720,
  enabled: true,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("schedule reminder builder preserves complete Profile-scoped schedule semantics", () => {
  const occurrenceKey = "2026-08-10T01:30:00.000Z:deadline:night-before";
  const notification = buildScheduleReminderNotification({
    item,
    occurrenceKey,
    occurrenceAt: "2026-08-10T01:30:00.000Z",
    deadlineAt: "2026-08-10T13:30:00.000Z",
    target: "deadline",
    reminderId: "night-before",
    reminderMinutes: 120,
    generatedAt: "2026-08-10T11:30:00.000Z",
  });

  assert.deepEqual(notification, {
    kind: "schedule.reminder",
    identity: `profile-a:schedule-42:${occurrenceKey}`,
    source: "schedule",
    scope: { type: "profile", profileId: "profile-a" },
    headline: "生日 · 截止提醒：妈妈生日",
    generatedAt: "2026-08-10T11:30:00.000Z",
    payload: {
      title: "妈妈生日",
      eventAt: "2026-08-10T01:30:00.000Z",
      occurrenceAt: "2026-08-10T01:30:00.000Z",
      deadlineAt: "2026-08-10T13:30:00.000Z",
      targetAt: "2026-08-10T13:30:00.000Z",
      target: "deadline",
      reminderId: "night-before",
      timezone: "Asia/Shanghai",
      reminderMinutes: 120,
      type: "birthday",
      status: "active",
      note: "提前订蛋糕",
      priority: "high",
      allDay: false,
      generatedAt: "2026-08-10T11:30:00.000Z",
    },
  });
});

test("new semantic schedule reminders render stable plain or platform-specific markdown per target", () => {
  const notification = buildScheduleReminderNotification({
    item,
    occurrenceKey: "2026-08-10T01:30:00.000Z:occurrence:two-hours",
    occurrenceAt: "2026-08-10T01:30:00.000Z",
    deadlineAt: "2026-08-10T13:30:00.000Z",
    target: "occurrence",
    reminderId: "two-hours",
    reminderMinutes: 120,
    generatedAt: "2026-08-09T23:30:00.000Z",
  });
  const expected = {
    title: "生日 · 发生提醒：妈妈生日",
    body: [
      "生日 · 发生提醒：妈妈生日",
      "发生时间：今天 09:30",
      "相对：还有 2 小时 0 分钟",
      "备注：提前订蛋糕",
    ].join("\n"),
  };
  // 阶段 B：平台分支取代旧的「qq-markdown === plain」契约。
  // markdown 投影 = `# ` 标题 + 加粗标签 + 块间空行 + 省略与 headline 相同的首行。
  const expectedMarkdown = {
    title: "# 生日 · 发生提醒：妈妈生日",
    body: [
      "**发生时间**：今天 09:30",
      "**相对**：还有 2 小时 0 分钟",
      "**备注**：提前订蛋糕",
    ].join("\n\n"),
  };

  assert.deepEqual(renderNotification(notification), expected);
  assert.deepEqual(renderNotification(notification, "plain"), expected);
  assert.deepEqual(renderNotification(notification, "wechat-markdown"), expectedMarkdown);
  assert.deepEqual(renderNotification(notification, "qq-markdown"), expectedMarkdown);
  assert.deepEqual(renderNotification(notification, "feishu-markdown"), expectedMarkdown);
  assert.deepEqual(
    renderNotification(notification, "future-platform" as NotificationRenderTarget),
    expected,
  );
});

test("relative schedule time follows the item timezone for today, tomorrow, future days, and overdue durations", () => {
  const cases = [
    {
      name: "today within 24 hours",
      occurrenceAt: "2026-08-07T02:30:00.000Z",
      generatedAt: "2026-08-07T00:00:00.000Z",
      timeLine: "发生时间：今天 10:30",
      relative: "相对：还有 2 小时 30 分钟",
    },
    {
      name: "tomorrow across local midnight",
      occurrenceAt: "2026-08-07T23:30:00.000Z",
      generatedAt: "2026-08-07T00:00:00.000Z",
      timeLine: "发生时间：明天 07:30",
      relative: "相对：还有 23 小时 30 分钟",
    },
    {
      name: "future local days",
      occurrenceAt: "2026-08-10T00:00:00.000Z",
      generatedAt: "2026-08-07T00:00:00.000Z",
      timeLine: "发生时间：2026-08-10 08:00",
      relative: "相对：还有 3 天",
    },
    {
      name: "overdue hours",
      occurrenceAt: "2026-08-06T19:00:00.000Z",
      generatedAt: "2026-08-07T00:00:00.000Z",
      timeLine: "发生时间：今天 03:00",
      relative: "相对：已逾期 5 小时",
    },
    {
      name: "overdue days",
      occurrenceAt: "2026-08-04T21:00:00.000Z",
      generatedAt: "2026-08-07T00:00:00.000Z",
      timeLine: "发生时间：2026-08-05 05:00",
      relative: "相对：已逾期 2 天",
    },
  ];

  for (const entry of cases) {
    const notification = buildScheduleReminderNotification({
      item: { ...item, type: "todo", title: entry.name, note: undefined },
      occurrenceKey: `${entry.occurrenceAt}:occurrence:test`,
      occurrenceAt: entry.occurrenceAt,
      deadlineAt: undefined,
      target: "occurrence",
      reminderId: "test",
      reminderMinutes: 0,
      generatedAt: entry.generatedAt,
    });
    const rendered = renderNotification(notification);
    assert.equal(rendered.body, [
      `待办 · 发生提醒：${entry.name}`,
      entry.timeLine,
      entry.relative,
    ].join("\n"));
    assert.doesNotMatch(rendered.body, /undefined|备注：/);
  }
});

test("relative schedule time handles zero and sub-minute boundaries", () => {
  const cases = [
    {
      name: "exactly now",
      occurrenceAt: "2026-08-07T00:00:00.000Z",
      generatedAt: "2026-08-07T00:00:00.000Z",
      relative: "相对：现在",
    },
    {
      name: "less than one minute away",
      occurrenceAt: "2026-08-07T00:00:30.000Z",
      generatedAt: "2026-08-07T00:00:00.000Z",
      relative: "相对：马上",
    },
    {
      name: "less than one minute overdue",
      occurrenceAt: "2026-08-06T23:59:30.000Z",
      generatedAt: "2026-08-07T00:00:00.000Z",
      relative: "相对：已逾期 1 分钟",
    },
  ];

  for (const entry of cases) {
    const notification = buildScheduleReminderNotification({
      item: { ...item, type: "todo", title: entry.name, note: undefined },
      occurrenceKey: `${entry.occurrenceAt}:occurrence:test`,
      occurrenceAt: entry.occurrenceAt,
      deadlineAt: undefined,
      target: "occurrence",
      reminderId: "test",
      reminderMinutes: 0,
      generatedAt: entry.generatedAt,
    });

    const rendered = renderNotification(notification);
    assert.match(rendered.body, new RegExp(`${entry.relative}$`));
    assert.doesNotMatch(rendered.body, /还有 0 小时 0 分钟|已逾期 0 小时/);
  }
});

test("deadline reminders label the deadline and distinguish anniversary semantics", () => {
  const notification = buildScheduleReminderNotification({
    item: { ...item, type: "anniversary", title: "相识纪念日", note: undefined },
    occurrenceKey: "2026-08-10T01:30:00.000Z:deadline:due",
    occurrenceAt: "2026-08-10T01:30:00.000Z",
    deadlineAt: "2026-08-10T13:30:00.000Z",
    target: "deadline",
    reminderId: "due",
    reminderMinutes: 0,
    generatedAt: "2026-08-10T12:30:00.000Z",
  });

  assert.deepEqual(renderNotification(notification), {
    title: "纪念日 · 截止提醒：相识纪念日",
    body: [
      "纪念日 · 截止提醒：相识纪念日",
      "截止时间：今天 21:30",
      "相对：还有 1 小时 0 分钟",
    ].join("\n"),
  });
});

test("all-day occurrences keep concrete deadline times for today and tomorrow", () => {
  const cases = [
    {
      name: "today",
      deadlineAt: "2026-08-10T10:00:00.000Z",
      generatedAt: "2026-08-10T00:00:00.000Z",
      timeLine: "截止时间：今天 18:00",
    },
    {
      name: "tomorrow",
      deadlineAt: "2026-08-11T10:00:00.000Z",
      generatedAt: "2026-08-10T00:00:00.000Z",
      timeLine: "截止时间：明天 18:00",
    },
  ];

  for (const entry of cases) {
    const notification = buildScheduleReminderNotification({
      item: {
        ...item,
        type: "todo",
        title: `${entry.name} deadline`,
        note: undefined,
        time: "09:00",
        allDay: true,
      },
      occurrenceKey: `2026-08-09T16:00:00.000Z:deadline:${entry.name}`,
      occurrenceAt: "2026-08-09T16:00:00.000Z",
      deadlineAt: entry.deadlineAt,
      target: "deadline",
      reminderId: entry.name,
      reminderMinutes: 0,
      generatedAt: entry.generatedAt,
    });

    assert.match(renderNotification(notification).body, new RegExp(`^${entry.timeLine}$`, "m"));
  }
});

test("all-day occurrence reminders hide the occurrence clock", () => {
  const notification = buildScheduleReminderNotification({
    item: {
      ...item,
      type: "todo",
      title: "全天事项",
      note: undefined,
      time: "09:00",
      allDay: true,
    },
    occurrenceKey: "2026-08-09T16:00:00.000Z:occurrence:all-day",
    occurrenceAt: "2026-08-09T16:00:00.000Z",
    target: "occurrence",
    reminderId: "all-day",
    reminderMinutes: 0,
    generatedAt: "2026-08-09T12:00:00.000Z",
  });

  const body = renderNotification(notification).body;
  assert.match(body, /^发生时间：明天$/m);
  assert.doesNotMatch(body, /发生时间：明天 00:00/);
});
