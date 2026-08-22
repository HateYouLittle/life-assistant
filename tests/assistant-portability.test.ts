import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// F13：assistant.export / assistant.import 备份迁移。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-portability-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "portability-profile";

const {
  buildAssistantExport,
  importAssistantExport,
} = await import("../src/modules/assistant/index.js");
const { createSchedule, getSchedule, updateSchedule } = await import("../src/modules/schedule/service.js");
const { createAutomation, getAutomation, listAutomations } = await import("../src/modules/automation/service.js");
const { getQuietHours, clearQuietHours, saveQuietHours } = await import("../src/core/notification-settings.js");
const { currentLocation, saveImportedLocation } = await import("../src/core/location.js");
const { store } = await import("../src/core/store.js");
const { getDatabase } = await import("../src/core/database.js");
const db = getDatabase();

const profile = { id: "portability-profile" };

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function seedProfileData() {
  const once = createSchedule(profile, {
    title: "未来一次性待办",
    calendar: "solar",
    date: "2099-06-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    reminders: [{ id: "r1", minutesBefore: 30 }],
  });
  const weekly = createSchedule(profile, {
    title: "每周例会",
    calendar: "solar",
    date: "2099-01-04",
    time: "10:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "weekly", byWeekday: ["MO"] },
  });
  const past = createSchedule(profile, {
    title: "已完成的旧待办",
    calendar: "solar",
    date: "2020-01-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  const archived = updateSchedule(profile, past.id, { status: "archived" });
  const lunar = createSchedule(profile, {
    title: "农历生日",
    calendar: "lunar",
    lunarMonth: 8,
    lunarDay: 15,
    time: "08:00",
    timezone: "Asia/Shanghai",
    recurrence: { frequency: "yearly" },
  });
  const automation = createAutomation(profile, {
    name: "冷到提醒",
    action: "weather.current",
    condition: { field: "temperature", op: "<", value: 5 },
    schedule: { type: "daily", time: "07:00", timezone: "Asia/Shanghai" },
  });
  saveQuietHours(profile.id, "22:30", "07:00", "Asia/Shanghai");
  saveImportedLocation({ city: "萍乡", province: "江西", lat: 27.62, lon: 113.85 });
  return { once, weekly, archived, lunar, automation };
}

test("export→wipe→import round-trips schedules, automations, quiet hours and location", () => {
  const seeded = seedProfileData();
  const snapshot = buildAssistantExport(profile);

  assert.equal(snapshot.format, "life-assistant.export");
  assert.equal(snapshot.profile, "portability-profile");
  assert.equal(snapshot.data.schedules.length, 4);
  assert.equal(snapshot.data.automations.length, 1);
  assert.deepEqual(snapshot.data.quietHours, { start: "22:30", end: "07:00", timezone: "Asia/Shanghai" });
  assert.equal(snapshot.data.location?.city, "萍乡");

  // 模拟换机：清空当前 Profile 数据后导入。
  db.prepare("DELETE FROM schedules WHERE profile_id = ?").run(profile.id);
  db.prepare("DELETE FROM automations WHERE profile_id = ?").run(profile.id);
  clearQuietHours(profile.id);
  store.del("location:current");

  const summary = importAssistantExport(profile, snapshot, { applyLocation: true });
  assert.deepEqual(summary, {
    schedules: { imported: 4, skipped: 0, invalid: 0 },
    automations: { imported: 1, skipped: 0, invalid: 0 },
    quietHoursApplied: true,
    locationApplied: true,
  });

  const once = getSchedule(profile, seeded.once.id);
  assert.equal(once.title, "未来一次性待办");
  assert.equal(once.status, "active");
  assert.deepEqual(once.reminders, [{ id: "r1", minutesBefore: 30, target: "occurrence" }]);

  const weekly = getSchedule(profile, seeded.weekly.id);
  assert.equal(weekly.recurrence.frequency, "weekly");
  assert.deepEqual(weekly.recurrence.byWeekday, ["MO"]);

  const archived = getSchedule(profile, seeded.archived.id);
  assert.equal(archived.status, "archived");

  const lunar = getSchedule(profile, seeded.lunar.id);
  assert.equal(lunar.calendar, "lunar");
  assert.equal(lunar.lunarMonth, 8);
  assert.equal(lunar.lunarDay, 15);

  const automation = getAutomation(profile, seeded.automation.id);
  assert.equal(automation.name, "冷到提醒");
  assert.deepEqual(automation.condition, { field: "temperature", op: "<", value: 5 });
  assert.equal((automation.schedule as { time: string }).time, "07:00");

  assert.deepEqual(getQuietHours(profile.id), { start: "22:30", end: "07:00", timezone: "Asia/Shanghai" });
  assert.equal(currentLocation()?.city, "萍乡");
});

test("import is idempotent and skips existing entries", () => {
  const snapshot = buildAssistantExport(profile);
  const summary = importAssistantExport(profile, snapshot);
  assert.equal(summary.schedules.imported, 0);
  assert.equal(summary.schedules.skipped, 4);
  assert.equal(summary.automations.skipped, 1);
  assert.equal(summary.locationApplied, false, "applyLocation 缺省不覆盖共享位置");
  assert.equal(listAutomations(profile).length, 1);
});

test("import does not touch the shared location unless applyLocation is set", () => {
  saveImportedLocation({ city: "北京", lat: 39.9, lon: 116.4 });
  const snapshot = buildAssistantExport(profile);
  store.del("location:current");
  importAssistantExport(profile, snapshot);
  assert.equal(currentLocation(), null, "缺省 applyLocation 时位置保持为空");
  importAssistantExport(profile, snapshot, { applyLocation: true });
  assert.equal(currentLocation()?.city, "北京");
});

test("invalid entries are counted and malformed payloads are rejected", () => {
  const summary = importAssistantExport(profile, {
    format: "life-assistant.export",
    version: 1,
    data: {
      schedules: [
        { id: "bad", title: "", calendar: "solar" }, // title 为空，schema 拒绝
        { calendar: "solar", title: "缺 id" },        // 缺 id
      ],
      automations: [{ id: "x", name: "未知动作", action: "nope.nope", schedule: { type: "interval", minutes: 10 } }],
    },
  });
  assert.equal(summary.schedules.invalid, 2);
  assert.equal(summary.automations.invalid, 1);

  assert.throws(() => importAssistantExport(profile, { format: "something.else", version: 1, data: {} }));
});
