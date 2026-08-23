import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

// F2：动态 automation（白名单 action + 条件 DSL + scheduler 扫描）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-automation-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "automation-profile";
process.env.LIFE_ASSISTANT_TIMEZONE = "UTC";

const {
  createAutomation,
  deleteAutomation,
  evaluateCondition,
  getAutomation,
  isAutomationDue,
  listAutomations,
  runAutomationNow,
  runAutomationScan,
  updateAutomation,
} = await import("../src/modules/automation/service.js");
const { automationModule } = await import("../src/modules/automation/index.js");
const { getDatabase } = await import("../src/core/database.js");
const db = getDatabase();

const profile = { id: "automation-profile" };

interface Captured {
  profileId: string;
  source: string;
  title: string;
  body: string;
  dedupeKey: string;
}

function capture(): { calls: Captured[]; publishProfile: (profileId: string, source: string, title: string, body: string, dedupeKey: string) => Promise<void> } {
  const calls: Captured[] = [];
  return {
    calls,
    publishProfile: async (profileId, source, title, body, dedupeKey) => {
      calls.push({ profileId, source, title, body, dedupeKey });
    },
  };
}

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// 每个用例结束后清空本 Profile 的 automations：断言失败时测试会在自己的
// deleteAutomation 清理之前中止，残留的启用行会污染后续 scan 用例的计数
// （曾导致"scan 隔离失败"、"scan 跳过停用"随"scan 执行"一起连锁失败）。
afterEach(() => {
  db.prepare("DELETE FROM automations WHERE profile_id = ?").run(profile.id);
});

test("create persists a normalized daily automation and validates inputs", () => {
  const item = createAutomation(profile, {
    name: "早晨冷提醒",
    action: "weather.current",
    params: {},
    condition: { field: "temperature", op: "<", value: 5 },
    schedule: { type: "daily", time: "07:00" },
  });
  assert.equal(item.profileId, "automation-profile");
  assert.equal(item.schedule.type, "daily");
  assert.equal((item.schedule as { timezone: string }).timezone, "UTC");
  assert.equal(item.enabled, true);
  assert.deepEqual(item.condition, { field: "temperature", op: "<", value: 5 });
  assert.equal(getAutomation(profile, item.id).name, "早晨冷提醒");

  assert.throws(() => createAutomation(profile, {
    name: "x", action: "nope.nope", schedule: { type: "interval", minutes: 10 },
  }), /未知 action/);
  assert.throws(() => createAutomation(profile, {
    name: "x", action: "weather.current", schedule: { type: "daily", time: "25:00" },
  }), /HH:mm/);
  assert.throws(() => createAutomation(profile, {
    name: "x", action: "weather.current", schedule: { type: "interval", minutes: 1 },
  }), /"minimum": 5/);
  deleteAutomation(profile, item.id);
});

test("update can change fields and clear the condition with null", () => {
  const item = createAutomation(profile, {
    name: "油价观察",
    action: "oilprice.current",
    schedule: { type: "interval", minutes: 60 },
  });
  const updated = updateAutomation(profile, item.id, {
    condition: { field: "p92", op: ">=", value: 8 },
    enabled: false,
    name: "油价观察（停用）",
  });
  assert.equal(updated.name, "油价观察（停用）");
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.condition, { field: "p92", op: ">=", value: 8 });

  const cleared = updateAutomation(profile, item.id, { condition: null });
  assert.equal(cleared.condition, undefined);
  deleteAutomation(profile, item.id);
  assert.throws(() => getAutomation(profile, item.id), /不存在/);
});

test("interval due logic respects lastRunAt", () => {
  const item = createAutomation(profile, {
    name: "interval due",
    action: "weather.current",
    schedule: { type: "interval", minutes: 30 },
  });
  assert.equal(isAutomationDue(item, new Date("2027-01-01T08:00:00Z")), true);
  const run = { ...item, lastRunAt: "2027-01-01T08:00:00Z" };
  assert.equal(isAutomationDue(run, new Date("2027-01-01T08:29:00Z")), false);
  assert.equal(isAutomationDue(run, new Date("2027-01-01T08:30:00Z")), true);
  deleteAutomation(profile, item.id);
});

test("daily due logic respects local time, timezone and same-day runs", () => {
  const item = createAutomation(profile, {
    name: "daily due",
    action: "weather.current",
    schedule: { type: "daily", time: "07:00", timezone: "Asia/Shanghai" },
  });
  // 北京 2027-01-01 06:59（UTC 前一日 22:59）未到点。
  assert.equal(isAutomationDue(item, new Date("2026-12-31T22:59:00Z")), false);
  // 北京 07:00 到点。
  assert.equal(isAutomationDue(item, new Date("2026-12-31T23:00:00Z")), true);
  const run = { ...item, lastRunAt: "2026-12-31T23:05:00Z" };
  assert.equal(isAutomationDue(run, new Date("2027-01-01T02:00:00Z")), false); // 同一北京日
  assert.equal(isAutomationDue(run, new Date("2026-12-31T23:05:00Z")), false);
  // 北京次日 07:00 再次到期。
  assert.equal(isAutomationDue(run, new Date("2027-01-01T23:00:00Z")), true);
  deleteAutomation(profile, item.id);
});

test("evaluateCondition compares numbers, strings, array paths and missing fields", () => {
  const result = {
    temperature: 3.5,
    weatherText: "小雨",
    days: [{ precipProb: 80 }],
    today: { precipProb: 80 },
  };
  assert.equal(evaluateCondition({ field: "temperature", op: "<", value: 5 }, result), true);
  assert.equal(evaluateCondition({ field: "temperature", op: "==", value: "3.5" }, result), true);
  assert.equal(evaluateCondition({ field: "weatherText", op: "==", value: "小雨" }, result), true);
  assert.equal(evaluateCondition({ field: "weatherText", op: "!=", value: "晴" }, result), true);
  assert.equal(evaluateCondition({ field: "days.0.precipProb", op: ">=", value: 60 }, result), true);
  assert.equal(evaluateCondition({ field: "today.precipProb", op: ">=", value: 60 }, result), true);
  assert.equal(evaluateCondition({ field: "nope", op: ">", value: 1 }, result), false);
  assert.equal(evaluateCondition({ field: "weatherText", op: ">", value: 10 }, result), false);
});

test("scan executes due automations, publishes per-day deduped notifications and records state", async () => {
  const publisher = capture();
  const actions = {
    "weather.current": {
      run: async () => ({ city: "北京", temperature: 2, weatherText: "小雪" }),
    },
    "airquality.current": {
      run: async () => ({ city: "北京", aqi: 30, category: "优" }),
    },
  };
  const cold = createAutomation(profile, {
    name: "冷到提醒",
    action: "weather.current",
    condition: { field: "temperature", op: "<", value: 5 },
    schedule: { type: "daily", time: "07:00", timezone: "UTC" },
  });
  const goodAir = createAutomation(profile, {
    name: "空气太好（不应触发）",
    action: "airquality.current",
    condition: { field: "aqi", op: ">=", value: 150 },
    schedule: { type: "daily", time: "07:00", timezone: "UTC" },
  });

  const at = new Date("2027-02-01T07:05:00Z");
  const outcomes = await runAutomationScan({ at, actions, publishProfile: publisher.publishProfile });
  assert.equal(outcomes.length, 2);
  // 按 id 定位结果而不是依赖数组下标：两个任务常在同一个毫秒内创建，
  // created_at 相同，排序 tie-break 历史上是随机 UUID，outcomes[0] 不恒等于 cold。
  const coldOutcome = outcomes.find((outcome) => outcome.id === cold.id);
  assert.ok(coldOutcome, "冷到提醒应在扫描结果中");
  assert.equal(coldOutcome.published, true);
  const goodAirOutcome = outcomes.find((outcome) => outcome.id === goodAir.id);
  assert.ok(goodAirOutcome, "空气太好应在扫描结果中");
  assert.equal(goodAirOutcome.published, false);

  assert.equal(publisher.calls.length, 1);
  assert.equal(publisher.calls[0].profileId, "automation-profile");
  assert.equal(publisher.calls[0].source, "automation");
  assert.equal(publisher.calls[0].title, "自动提醒 · 冷到提醒");
  assert.equal(publisher.calls[0].dedupeKey, `automation:${cold.id}:2027-02-01`);
  assert.match(publisher.calls[0].body, /触发条件：temperature 小于 5/);
  assert.match(publisher.calls[0].body, /temperature：2/);

  const coldRow = getAutomation(profile, cold.id);
  assert.equal(coldRow.lastRunAt, at.toISOString());
  assert.equal(coldRow.lastError, undefined);
  const goodAirRow = getAutomation(profile, goodAir.id);
  assert.equal(goodAirRow.lastRunAt, at.toISOString());
  assert.match(goodAirRow.lastResult!, /"published":false/);

  // 同日再扫描：daily 任务已运行，不再执行。
  const again = await runAutomationScan({ at: new Date("2027-02-01T09:00:00Z"), actions, publishProfile: publisher.publishProfile });
  assert.equal(again.length, 0);
  assert.equal(publisher.calls.length, 1);

  deleteAutomation(profile, cold.id);
  deleteAutomation(profile, goodAir.id);
});

test("interval automations dedupe to one notification per local date through the real publisher", async () => {
  const actions = {
    "weather.current": { run: async () => ({ temperature: 1 }) },
  };
  const item = createAutomation(profile, {
    name: "间隔冷提醒",
    action: "weather.current",
    condition: { field: "temperature", op: "<", value: 5 },
    schedule: { type: "interval", minutes: 5 },
  });

  await runAutomationScan({ at: new Date("2027-03-01T08:00:00Z"), actions });
  await runAutomationScan({ at: new Date("2027-03-01T08:30:00Z"), actions });
  const rows = db.prepare(`
    SELECT COUNT(*) AS count FROM profile_notifications
    WHERE profile_id = ? AND dedupe_key = ?
  `).get("automation-profile", `automation:${item.id}:2027-03-01`) as { count: number };
  assert.equal(rows.count, 1, "同一本地日期只应有一条主动提醒");

  deleteAutomation(profile, item.id);
});

test("scan isolates per-automation failures and records last_error", async () => {
  const actions = {
    "weather.current": { run: async () => { throw new Error("provider down"); } },
  };
  const failing = createAutomation(profile, {
    name: "失败任务",
    action: "weather.current",
    schedule: { type: "interval", minutes: 5 },
  });
  const healthyActions = {
    "airquality.current": { run: async () => ({ aqi: 200, category: "重度污染" }) },
  };
  const healthy = createAutomation(profile, {
    name: "正常任务",
    action: "airquality.current",
    schedule: { type: "interval", minutes: 5 },
  });

  const outcomes = await runAutomationScan({
    at: new Date("2027-04-01T08:00:00Z"),
    actions: { ...actions, ...healthyActions },
    publishProfile: capture().publishProfile,
  });
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.find((outcome) => outcome.id === failing.id)?.error, "provider down");
  assert.equal(outcomes.find((outcome) => outcome.id === healthy.id)?.published, true);

  assert.match(getAutomation(profile, failing.id).lastError!, /provider down/);
  // 失败也记 last_run_at，避免每个扫描周期重试放大故障。
  assert.ok(getAutomation(profile, failing.id).lastRunAt);

  deleteAutomation(profile, failing.id);
  deleteAutomation(profile, healthy.id);
});

test("scan skips disabled automations", async () => {
  const publisher = capture();
  const item = createAutomation(profile, {
    name: "停用任务",
    action: "weather.current",
    schedule: { type: "interval", minutes: 5 },
    enabled: false,
  });
  const outcomes = await runAutomationScan({
    at: new Date("2027-05-01T08:00:00Z"),
    actions: { "weather.current": { run: async () => ({ temperature: 1 }) } },
    publishProfile: publisher.publishProfile,
  });
  assert.equal(outcomes.length, 0);
  assert.equal(publisher.calls.length, 0);
  assert.equal(getAutomation(profile, item.id).lastRunAt, undefined);
  deleteAutomation(profile, item.id);
});

test("list and scan order rows with identical created_at by insertion order, not random id", async () => {
  // 直接落两条 created_at 完全相同的行（模拟批量导入/同毫秒创建），
  // id 词法序与插入序相反：若 tie-break 用随机 id，顺序不稳定（曾导致
  // "scan executes" 用例 ~45% 概率失败并连锁污染后续 scan 用例）。
  const time = "2027-07-01T00:00:00.000Z";
  const scheduleJson = JSON.stringify({ type: "interval", minutes: 5 });
  db.prepare(`
    INSERT INTO automations(profile_id, id, name, action, params_json, condition_json, schedule_json, enabled, created_at, updated_at)
    VALUES(?, 'zzz-inserted-first', '先插入', 'weather.current', '{}', NULL, ?, 1, ?, ?)
  `).run(profile.id, scheduleJson, time, time);
  db.prepare(`
    INSERT INTO automations(profile_id, id, name, action, params_json, condition_json, schedule_json, enabled, created_at, updated_at)
    VALUES(?, 'aaa-inserted-second', '后插入', 'weather.current', '{}', NULL, ?, 1, ?, ?)
  `).run(profile.id, scheduleJson, time, time);

  assert.deepEqual(
    listAutomations(profile).map((entry) => entry.id),
    ["zzz-inserted-first", "aaa-inserted-second"],
    "同 created_at 应按插入顺序（rowid）而不是随机 id",
  );
  const at = new Date("2027-07-01T08:00:00Z");
  const outcomes = await runAutomationScan({
    at,
    actions: { "weather.current": { run: async () => ({ temperature: 1 }) } },
    publishProfile: capture().publishProfile,
  });
  assert.deepEqual(
    outcomes.map((outcome) => outcome.id),
    ["zzz-inserted-first", "aaa-inserted-second"],
    "scan 执行顺序同样应按插入顺序",
  );
});

test("runAutomationNow executes immediately without advancing the schedule", async () => {
  const publisher = capture();
  const item = createAutomation(profile, {
    name: "手动验证",
    action: "weather.current",
    schedule: { type: "daily", time: "07:00", timezone: "UTC" },
  });
  const outcome = await runAutomationNow(profile, item.id, {
    at: new Date("2027-06-01T10:00:00Z"),
    actions: { "weather.current": { run: async () => ({ temperature: 9 }) } },
    publishProfile: publisher.publishProfile,
  });
  assert.equal(outcome.published, true);
  assert.deepEqual(Object.keys(outcome.result ?? {}).includes("temperature"), true);
  assert.match(publisher.calls[0].dedupeKey, /:run:2027-06-01T10:00$/);
  // 手动执行不推进 last_run_at：既定 daily 07:00 调度不受影响。
  assert.equal(getAutomation(profile, item.id).lastRunAt, undefined);
  deleteAutomation(profile, item.id);
});

test("automation tools reject cross-profile access and invalid payloads", async () => {
  const create = automationModule.tools!.find((tool) => tool.name === "create")!;
  const list = automationModule.tools!.find((tool) => tool.name === "list")!;

  const created = await create.handler({
    name: "工具创建",
    action: "weather.current",
    condition: { field: "temperature", op: "<", value: 0 },
    schedule: { type: "interval", minutes: 15 },
  }, profile);
  const payload = JSON.parse((created.content[0] as { text: string }).text) as { id: string };
  assert.ok(payload.id);

  const invalid = await create.handler({
    name: "坏任务",
    action: "weather.current",
    schedule: { type: "interval", minutes: 3 },
  }, profile);
  assert.equal(invalid.isError, true);

  // list 只返回当前 Profile 的任务；其它 Profile 无权访问。
  const listed = await list.handler({}, profile);
  const listPayload = JSON.parse((listed.content[0] as { text: string }).text) as {
    automations: Array<{ profileId: string }>;
  };
  assert.ok(listPayload.automations.every((entry) => entry.profileId === "automation-profile"));
});

test("scan isolates a corrupted automation row instead of halting the whole loop", async () => {
  const good = createAutomation(profile, {
    name: "损坏行隔离探针",
    action: "weather.current",
    params: {},
    schedule: { type: "daily", time: "07:00", timezone: "UTC" },
  });
  // 隔离本测试：停用此前用例遗留的其他任务，保证 publisher 计数只来自本测试的两行。
  db.prepare("UPDATE automations SET enabled = 0 WHERE profile_id = ? AND id <> ?")
    .run(profile.id, good.id);
  // 直接落一行损坏数据（截断的 schedule_json），created_at 排在探针之前：
  // 修复前 rowToItem 在 per-item try 之外抛出，会让整个扫描循环停摆。
  db.prepare(`
    INSERT INTO automations(profile_id, id, name, action, params_json, condition_json, schedule_json, enabled, created_at, updated_at)
    VALUES(?, 'corrupt-row', '损坏行', 'weather.current', '{}', NULL, '{"type":"daily","time":', 1,
      '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
  `).run(profile.id);

  const actions = {
    "weather.current": { run: async () => ({ temperature: 20 }) },
  };
  const publisher = capture();
  const at = new Date("2027-04-01T07:05:00Z");
  const outcomes = await runAutomationScan({ at, actions, publishProfile: publisher.publishProfile });

  const corruptOutcome = outcomes.find((outcome) => outcome.id === "corrupt-row");
  assert.ok(corruptOutcome, "损坏行应出现在结果里而不是炸掉扫描");
  assert.equal(corruptOutcome.ran, false);
  assert.ok(corruptOutcome.error);
  const goodOutcome = outcomes.find((outcome) => outcome.id === good.id);
  assert.ok(goodOutcome, "排在损坏行之后的正常任务仍应被执行");
  assert.equal(goodOutcome.published, true);
  assert.equal(publisher.calls.length, 1);

  const corruptRow = db.prepare(
    "SELECT last_error FROM automations WHERE profile_id = ? AND id = 'corrupt-row'",
  ).get(profile.id) as { last_error: string | null };
  assert.ok(corruptRow.last_error, "损坏原因应落库到 last_error 供 automation.list 排查");

  deleteAutomation(profile, good.id);
  db.prepare("DELETE FROM automations WHERE profile_id = ? AND id = ?").run(profile.id, "corrupt-row");
});
