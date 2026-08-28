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
const { currentLocation, saveImportedLocation } = await import("../src/modules/location/index.js");
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
  // 未来快照版本必须显式拒绝，不能被当成 v1/v2 静默导入。
  assert.throws(
    () => importAssistantExport(profile, { format: "life-assistant.export", version: 3, data: {} }),
    /不支持的快照版本 3/,
  );
  assert.throws(() => importAssistantExport(profile, "not-an-object"), /不是有效的快照对象/);
});

test("export marks truncation when the row limit is exceeded", () => {
  const seed = createSchedule(profile, {
    title: "截断种子",
    calendar: "solar",
    date: "2099-09-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  const row = db.prepare("SELECT * FROM schedules WHERE profile_id = ? AND id = ?").get(profile.id, seed.id) as Record<string, unknown>;
  const columns = Object.keys(row);
  const insert = db.prepare(
    `INSERT INTO schedules(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  );
  const bulkCount = 1000; // 种子 + 1000 条 bulk，确保超过上限
  const tx = db.prepare("BEGIN");
  tx.run();
  for (let index = 0; index < bulkCount; index += 1) {
    insert.run(...columns.map((column) => (column === "id" ? `bulk-${index}` : row[column])) as never);
  }
  db.prepare("COMMIT").run();
  try {
    const snapshot = buildAssistantExport(profile);
    assert.equal(snapshot.data.schedules.length, 1000);
    assert.equal(snapshot.data.truncated, true);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id LIKE 'bulk-%'").run(profile.id);
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(profile.id, seed.id);
  }
  // 清理后回到未截断状态。
  assert.equal(buildAssistantExport(profile).data.truncated, false);
});

test("export does not mark an exactly full category as truncated", () => {
  const exactProfile = { id: "exact-limit-profile" };
  const seed = createSchedule(exactProfile, {
    title: "精确上限种子",
    calendar: "solar",
    date: "2099-12-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
  });
  const row = db.prepare("SELECT * FROM schedules WHERE profile_id = ? AND id = ?").get(exactProfile.id, seed.id) as Record<string, unknown>;
  const columns = Object.keys(row);
  const insert = db.prepare(
    `INSERT INTO schedules(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  );
  let committed = false;
  try {
    db.exec("BEGIN");
    for (let index = 0; index < 999; index += 1) {
      insert.run(...columns.map((column) => (column === "id" ? `exact-${index}` : row[column])) as never);
    }
    db.exec("COMMIT");
    committed = true;
    const snapshot = buildAssistantExport(exactProfile);
    assert.equal(snapshot.data.schedules.length, 1000);
    assert.equal(snapshot.data.truncated, false);
  } finally {
    if (!committed) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the original assertion failure */ }
    }
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id LIKE 'exact-%'").run(exactProfile.id);
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(exactProfile.id, seed.id);
  }
});

test("import rejects snapshots exceeding 1000 entries per type", () => {
  // 导出侧单类型截断到 1000 条；导入侧同样封顶，超大/恶意快照直接拒绝
  // 而不是长时间占住 MCP 调用逐条 SELECT+INSERT。
  const snapshot = {
    format: "life-assistant.export",
    version: 1,
    data: { schedules: new Array(1001).fill({}) },
  };
  assert.throws(
    () => importAssistantExport(profile, snapshot),
    /Too many|array|schedules/i,
  );
});

test("P1: strong reminder config round-trips through export/import (v2)", () => {
  const strong = createSchedule(profile, {
    title: "强提醒待办",
    calendar: "solar",
    date: "2099-10-01",
    time: "09:00",
    timezone: "Asia/Shanghai",
    intervalMinutes: 60,
    maxAttempts: 5,
  });
  try {
    const snapshot = buildAssistantExport(profile);
    // 导出格式升到 v2，且快照携带强提醒字段。
    assert.equal(snapshot.version, 2);
    const portable = snapshot.data.schedules.find((entry) => entry.id === strong.id);
    assert.ok(portable, "导出快照应包含强提醒日程");
    assert.equal(portable.intervalMinutes, 60);
    assert.equal(portable.maxAttempts, 5);

    // 导入 v2 快照（换新 ID 避免与既有条目撞车跳过）→ 强提醒恢复。
    const v2Payload = {
      format: snapshot.format,
      version: snapshot.version,
      data: { schedules: [{ ...portable, id: "imported-strong" }] },
    };
    const summary = importAssistantExport(profile, v2Payload);
    assert.deepEqual(summary.schedules, { imported: 1, skipped: 0, invalid: 0 });
    const restored = getSchedule(profile, "imported-strong");
    assert.equal(restored.reminderIntervalMinutes, 60);
    assert.equal(restored.reminderMaxAttempts, 5);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id IN (?, ?)").run(profile.id, strong.id, "imported-strong");
  }
});

test("P1: v1 snapshots import without strong reminder (columns stay NULL)", () => {
  const v1 = {
    format: "life-assistant.export",
    version: 1,
    data: {
      schedules: [{
        id: "legacy-v1",
        title: "老快照待办",
        calendar: "solar",
        date: "2099-11-01",
        time: "09:00",
        timezone: "Asia/Shanghai",
        reminders: [{ id: "r1", minutesBefore: 0 }],
      }],
    },
  };
  try {
    const summary = importAssistantExport(profile, v1);
    assert.deepEqual(summary.schedules, { imported: 1, skipped: 0, invalid: 0 });
    const imported = getSchedule(profile, "legacy-v1");
    // v1 无强提醒字段：导入后强提醒未开启（两列 NULL）。
    assert.equal(imported.reminderIntervalMinutes, undefined);
    assert.equal(imported.reminderMaxAttempts, undefined);
    const row = db.prepare(
      "SELECT reminder_interval_minutes, reminder_max_attempts FROM schedules WHERE profile_id = ? AND id = ?",
    ).get(profile.id, "legacy-v1") as { reminder_interval_minutes: unknown; reminder_max_attempts: unknown };
    assert.equal(row.reminder_interval_minutes, null);
    assert.equal(row.reminder_max_attempts, null);
  } finally {
    db.prepare("DELETE FROM schedules WHERE profile_id = ? AND id = ?").run(profile.id, "legacy-v1");
  }
});

test("P1: v1/v2 both accepted; out-of-range versions rejected with a clear message", () => {
  // v1 与 v2 均放行（v1 上面已测内容，这里只验证不被版本门拒收）。
  assert.doesNotThrow(() => importAssistantExport(profile, { format: "life-assistant.export", version: 1, data: {} }));
  assert.doesNotThrow(() => importAssistantExport(profile, { format: "life-assistant.export", version: 2, data: {} }));
  // 超出 [1,2] 的版本显式拒绝，错误信息带版本号。
  assert.throws(
    () => importAssistantExport(profile, { format: "life-assistant.export", version: 3, data: {} }),
    /不支持的快照版本 3（当前支持版本 1-2）/,
  );
});

test("M6: import pre-validates quietHours before any write (no partial import on bad timezone)", () => {
  const countBefore = db.prepare("SELECT COUNT(*) AS count FROM schedules WHERE profile_id = ?")
    .get(profile.id) as { count: number };
  const automationCountBefore = db.prepare("SELECT COUNT(*) AS count FROM automations WHERE profile_id = ?")
    .get(profile.id) as { count: number };
  const payload = {
    format: "life-assistant.export",
    version: 2,
    data: {
      schedules: [{
        id: "m6-should-not-persist",
        title: "不应落库的日程",
        calendar: "solar",
        date: "2099-06-01",
        time: "09:00",
        timezone: "Asia/Shanghai",
        reminders: [{ id: "r1", minutesBefore: 0 }],
      }],
      quietHours: { start: "22:00", end: "07:00", timezone: "Not/AZone" },
    },
  };
  // 非法时区在导入任何条目之前整体失败，而不是「部分导入 + 整体报错」。
  assert.throws(() => importAssistantExport(profile, payload), /无效时区：Not\/AZone/);
  const countAfter = db.prepare("SELECT COUNT(*) AS count FROM schedules WHERE profile_id = ?")
    .get(profile.id) as { count: number };
  const automationCountAfter = db.prepare("SELECT COUNT(*) AS count FROM automations WHERE profile_id = ?")
    .get(profile.id) as { count: number };
  assert.equal(countAfter.count, countBefore.count, "非法 quietHours 时不允许任何日程落库");
  assert.equal(automationCountAfter.count, automationCountBefore.count, "非法 quietHours 时不允许任何 automation 落库");
  assert.throws(() => getSchedule(profile, "m6-should-not-persist"), /not found/);
});

test("L10: export skips a corrupted automation row and flags invalidAutomations instead of failing", () => {
  // 直接落一行 schedule_json 截断的损坏行：修复前 JSON.parse 会让整个导出抛出。
  db.prepare(`
    INSERT INTO automations(profile_id, id, name, action, params_json, condition_json, schedule_json, enabled, created_at, updated_at)
    VALUES(?, 'corrupt-export-row', '损坏行', 'weather.current', '{}', NULL, '{"type":"daily","time":', 1,
      '2027-02-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z')
  `).run(profile.id);
  try {
    const snapshot = buildAssistantExport(profile);
    assert.ok(!snapshot.data.automations.some((entry) => entry.id === "corrupt-export-row"),
      "损坏行应被跳过而不是拖垮导出");
    assert.equal(snapshot.data.invalidAutomations, 1, "损坏行应计入 invalidAutomations 供导入方提示");
    // 其余合法 automation 不受影响。
    assert.ok(snapshot.data.automations.length >= 1);
  } finally {
    db.prepare("DELETE FROM automations WHERE profile_id = ? AND id = ?").run(profile.id, "corrupt-export-row");
  }
  assert.equal(buildAssistantExport(profile).data.invalidAutomations, undefined, "无损坏行时不应带 invalidAutomations 标记");
});

test("L1-fix: export skips a corrupted condition column row instead of exporting it unconditionally", () => {
  // condition_json 截断、schedule_json 合法：修复前该行被导出成「无条件」，
  // 导入后会从「条件触发」漂移成「到点必提醒」，语义静默改变。
  db.prepare(`
    INSERT INTO automations(profile_id, id, name, action, params_json, condition_json, schedule_json, enabled, created_at, updated_at)
    VALUES(?, 'corrupt-condition-row', '条件损坏行', 'weather.current', '{}', '{"field":"humidity","op":', '{"type":"interval","minutes":30}', 1,
      '2027-02-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z')
  `).run(profile.id);
  try {
    const snapshot = buildAssistantExport(profile);
    assert.ok(!snapshot.data.automations.some((entry) => entry.id === "corrupt-condition-row"),
      "condition 列损坏的行应被跳过而不是导出成无条件");
    assert.equal(snapshot.data.invalidAutomations, 1, "condition 损坏行应计入 invalidAutomations");
    // condition_json 为 NULL 的合法行不受影响，condition 正常缺省。
    assert.ok(snapshot.data.automations.every((entry) => entry.condition !== null));
  } finally {
    db.prepare("DELETE FROM automations WHERE profile_id = ? AND id = ?").run(profile.id, "corrupt-condition-row");
  }
  assert.equal(buildAssistantExport(profile).data.invalidAutomations, undefined);
});
