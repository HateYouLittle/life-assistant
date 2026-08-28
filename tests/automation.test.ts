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

function capture(): { calls: Captured[]; publishProfile: (input: { profileId: string; source?: string; title: string; body: string; dedupeKey?: string }) => Promise<void> } {
  const calls: Captured[] = [];
  return {
    calls,
    publishProfile: async (input) => {
      calls.push({ profileId: input.profileId, source: input.source ?? "schedule", title: input.title, body: input.body, dedupeKey: input.dedupeKey ?? "" });
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
  // interval 失败仍记 last_run_at，避免每个扫描周期重试放大故障。
  assert.ok(getAutomation(profile, failing.id).lastRunAt);
  // L35：失败路径 last_result 置 NULL，避免「旧成功结果 + 新错误」并存。
  assert.equal(getAutomation(profile, failing.id).lastResult, undefined, "失败后不应残留旧的成功结果");

  deleteAutomation(profile, failing.id);
  deleteAutomation(profile, healthy.id);
});

test("L34: a daily failure keeps the day retryable; success then dedupes the same local day", async () => {
  const publisher = capture();
  let calls = 0;
  const actions = {
    "weather.current": {
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient outage");
        return { temperature: 1, weatherText: "晴" };
      },
    },
  };
  const daily = createAutomation(profile, {
    name: "日常重试任务",
    action: "weather.current",
    schedule: { type: "daily", time: "07:00", timezone: "UTC" },
  });

  const first = await runAutomationScan({ at: new Date("2027-08-01T07:05:00Z"), actions, publishProfile: publisher.publishProfile });
  const failOutcome = first.find((outcome) => outcome.id === daily.id);
  assert.equal(failOutcome?.ran, false);
  assert.match(failOutcome?.error ?? "", /transient outage/);
  // daily 失败不推进 last_run_at：isAutomationDue 的当日去重按 lastRunAt 同本地日，
  // 推进会让「一次失败即丢一整天」（与 interval 行为不对称）。
  assert.equal(getAutomation(profile, daily.id).lastRunAt, undefined);
  assert.match(getAutomation(profile, daily.id).lastError!, /transient outage/);

  // 当日再次扫描 → 重试并成功。
  const second = await runAutomationScan({ at: new Date("2027-08-01T07:05:30Z"), actions, publishProfile: publisher.publishProfile });
  const okOutcome = second.find((outcome) => outcome.id === daily.id);
  assert.equal(okOutcome?.ran, true);
  assert.equal(okOutcome?.published, true);
  assert.ok(getAutomation(profile, daily.id).lastRunAt, "成功后 last_run_at 写入，触发当日去重");
  assert.equal(getAutomation(profile, daily.id).lastError, undefined);

  // 成功后同一本地日不再重复。
  const again = await runAutomationScan({ at: new Date("2027-08-01T09:00:00Z"), actions, publishProfile: publisher.publishProfile });
  assert.equal(again.length, 0);
  assert.equal(publisher.calls.length, 1, "当日只有一次主动提醒");

  deleteAutomation(profile, daily.id);
});

test("L35: failure clears a stale success last_result; success clears last_error", async () => {
  let fail = false;
  const actions = {
    "weather.current": {
      run: async () => {
        if (fail) throw new Error("later outage");
        return { temperature: 2, weatherText: "小雪" };
      },
    },
  };
  const item = createAutomation(profile, {
    name: "成败交替任务",
    action: "weather.current",
    schedule: { type: "interval", minutes: 5 },
  });
  const at = new Date("2027-09-01T08:00:00Z");
  const ok = await runAutomationScan({ at, actions, publishProfile: capture().publishProfile });
  assert.equal(ok.find((outcome) => outcome.id === item.id)?.published, true);
  assert.ok(getAutomation(profile, item.id).lastResult, "成功后应记录 last_result");

  fail = true;
  const bad = await runAutomationScan({ at: new Date("2027-09-01T08:06:00Z"), actions, publishProfile: capture().publishProfile });
  assert.match(bad.find((outcome) => outcome.id === item.id)?.error ?? "", /later outage/);
  const afterFailure = getAutomation(profile, item.id);
  assert.equal(afterFailure.lastResult, undefined, "失败后旧的 last_result 必须被清空");
  assert.match(afterFailure.lastError!, /later outage/);

  fail = false;
  const again = await runAutomationScan({ at: new Date("2027-09-01T08:12:00Z"), actions, publishProfile: capture().publishProfile });
  assert.equal(again.find((outcome) => outcome.id === item.id)?.published, true);
  const afterSuccess = getAutomation(profile, item.id);
  assert.ok(afterSuccess.lastResult, "再次成功后重新记录 last_result");
  assert.equal(afterSuccess.lastError, undefined, "成功后 last_error 被清空，与 lastResult 互斥");

  deleteAutomation(profile, item.id);
});

test("L36: condition fields are validated against the action result whitelist at create/update", () => {
  // 白名单外字段创建被拒。
  assert.throws(
    () => createAutomation(profile, {
      name: "坏字段",
      action: "weather.current",
      condition: { field: "nope", op: "==", value: 1 },
      schedule: { type: "interval", minutes: 10 },
    }),
    /不在 action weather\.current 的结果字段白名单内/,
  );
  // 白名单内字段通过（today.* 与数组下标 days.{i}.* 通配）。
  const okForecast = createAutomation(profile, {
    name: "降水提醒",
    action: "weather.forecast",
    condition: { field: "today.precipAmountMm", op: ">=", value: 1 },
    schedule: { type: "daily", time: "07:00", timezone: "UTC" },
  });
  const okArrayIndex = createAutomation(profile, {
    name: "数组下标条件",
    action: "weather.forecast",
    condition: { field: "days.0.precipProb", op: ">=", value: 60 },
    schedule: { type: "daily", time: "07:00", timezone: "UTC" },
  });
  // 白名单校验也作用于 update。
  assert.throws(
    () => updateAutomation(profile, okForecast.id, {
      condition: { field: "today.notARealField", op: ">", value: 1 },
    }),
    /不在 action weather\.forecast 的结果字段白名单内/,
  );
  deleteAutomation(profile, okForecast.id);
  deleteAutomation(profile, okArrayIndex.id);
});

test("L36: string condition values reject ordering ops; numeric coercion keeps deterministic semantics", async () => {
  // 字符串值 + 大小比较（字典序 "9" > "10" 为 true，语义不可控）创建即拒绝。
  assert.throws(
    () => createAutomation(profile, {
      name: "字符串大小比较",
      action: "oilprice.current",
      condition: { field: "p92", op: ">", value: "9" },
      schedule: { type: "interval", minutes: 10 },
    }),
    /字符串比较仅支持 == \/ !=/,
  );
  // 字符串 == / != 仍然允许。
  const ok = createAutomation(profile, {
    name: "字符串等于",
    action: "weather.forecast",
    condition: { field: "today.weatherText", op: "==", value: "小雨" },
    schedule: { type: "interval", minutes: 10 },
  });
  deleteAutomation(profile, ok.id);

  // 运行时：数字条件值对字符串实际值走数值化（"9" 数字语义，而非字典序）。
  assert.equal(evaluateCondition({ field: "p92", op: ">", value: 10 }, { p92: "9" }), false, "9 > 10 应为 false");
  assert.equal(evaluateCondition({ field: "p92", op: ">", value: 8 }, { p92: "9" }), true, "9 > 8 应为 true");
});

test("L36: __proto__/constructor paths cannot probe the prototype chain", () => {
  // 创建层：白名单本身就拒绝任意非结果字段（含原型链段）。
  assert.throws(
    () => createAutomation(profile, {
      name: "原型探针",
      action: "weather.current",
      condition: { field: "__proto__.polluted", op: "==", value: 1 },
      schedule: { type: "interval", minutes: 10 },
    }),
    /结果字段白名单/,
  );
  // 求值层纵深防御：x 没有自有 __proto__ 时，历史实现 `record[segment]` 会取到
  // Object.prototype 再 .constructor 得到 Function——条件可被用来探测原型链。
  assert.equal(
    evaluateCondition({ field: "x.__proto__.constructor", op: "!=", value: "x" }, { x: {} }),
    false,
    "__proto__ 段应视为字段缺失（条件不满足）而不是穿透到原型链",
  );
  assert.equal(
    evaluateCondition({ field: "x.constructor.name", op: "==", value: "Object" }, { x: {} }),
    false,
    "constructor 段同样拒绝",
  );
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
  // L37：手动执行复用 scan 的当日 identity（去掉 :run: 分钟桶），与「每个本地日期
  // 最多提醒一次」语义一致：同一分钟 scan 与 run 命中同一任务不再双键双发。
  assert.equal(publisher.calls[0].dedupeKey, `automation:${item.id}:2027-06-01`);
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

// ---------------------------------------------------------------------------
// §6b：真实 action 的 schema 与 run() 冒烟（此前 run() 只在注入 mock action 表时执行，
// paramsSchema 仅被平凡空对象解析；这里直连 automationActions 锁定结果字段名）。
// ---------------------------------------------------------------------------

const { automationActions } = await import("../src/modules/automation/actions.js");
const { config: automationConfig } = await import("../src/config.js");
const { saveImportedLocation } = await import("../src/modules/location/index.js");

test("§6b: weather.forecast paramsSchema rejects out-of-range days and city length", () => {
  const schema = automationActions["weather.forecast"].paramsSchema;
  assert.ok(schema.safeParse({}).success, "days 缺省 1");
  assert.equal(schema.parse({}).days, 1);
  assert.ok(schema.safeParse({ days: 3 }).success);
  assert.ok(!schema.safeParse({ days: 0 }).success, "days:0 必须拒绝");
  assert.ok(!schema.safeParse({ days: 8 }).success, "days:8 必须拒绝（上限 7）");
  assert.ok(!schema.safeParse({ days: -1 }).success);
  assert.ok(!schema.safeParse({ days: 1.5 }).success, "days 必须为整数");
  // city 边界：1..64，空字符串拒绝。
  assert.ok(schema.safeParse({ city: "a".repeat(64) }).success);
  assert.ok(!schema.safeParse({ city: "a".repeat(65) }).success);
  assert.ok(!schema.safeParse({ city: "" }).success);
});

test("§6b: real weather/airquality/oilprice actions smoke-run against a stubbed network and lock result fields", async (t) => {
  const keyBefore = automationConfig.qweatherKey;
  const tianapiBefore = automationConfig.tianapiKey;
  const juheBefore = automationConfig.juheKey;
  const fetchBefore = globalThis.fetch;
  // 已确认位置（萍乡/江西）：resolveLocation/requireConfirmedLocation 与 oilprice.provinceOf 依赖它。
  saveImportedLocation({ city: "萍乡", province: "江西", lat: 27.62, lon: 113.85 });
  automationConfig.qweatherKey = ""; // 全部走 Open-Meteo 免 Key 路径
  automationConfig.tianapiKey = "";
  automationConfig.juheKey = "test-juhe";
  globalThis.fetch = (async (input) => {
    const url = String(input);
    // air-quality-api.open-meteo.com 也包含 "open-meteo" 与 "current="，必须先匹配。
    if (url.includes("air-quality")) {
      return Response.json({
        current: { pm2_5: 35, pm10: 40, ozone: 100, nitrogen_dioxide: 20, sulphur_dioxide: 10, us_aqi: 85 },
      });
    }
    if (url.includes("api.open-meteo.com") && url.includes("current=")) {
      return Response.json({
        current: { temperature_2m: 8, relative_humidity_2m: 70, apparent_temperature: 6, weather_code: 61, wind_speed_10m: 3.5 },
      });
    }
    if (url.includes("api.open-meteo.com") && url.includes("daily=weather_code")) {
      return Response.json({
        daily: {
          time: ["2027-01-02"],
          temperature_2m_max: [10],
          temperature_2m_min: [5],
          weather_code: [61],
          precipitation_probability_max: [70],
        },
      });
    }
    if (url.includes("apis.juhe.cn")) {
      return Response.json({
        error_code: 0,
        reason: "success",
        result: [{ city: "江西", "92h": "7.52", "95h": "8.05", "0h": "7.12" }],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  t.after(() => {
    automationConfig.qweatherKey = keyBefore;
    automationConfig.tianapiKey = tianapiBefore;
    automationConfig.juheKey = juheBefore;
    globalThis.fetch = fetchBefore;
  });

  // 条件 DSL 与通知渲染引用这些字段名，锁定返回结构避免改名悄悄破坏用户条件。
  const current = await automationActions["weather.current"].run({});
  assert.equal(current.city, "萍乡");
  assert.equal(typeof current.temperature, "number");
  assert.equal(typeof current.humidity, "number");
  assert.equal(typeof current.windSpeed, "number");
  assert.equal(typeof current.weatherText, "string");

  const forecast = await automationActions["weather.forecast"].run({ days: 1 });
  assert.equal(forecast.city, "萍乡");
  assert.ok(Array.isArray(forecast.days) && forecast.days.length === 1);
  assert.equal(forecast.today, forecast.days[0]);
  const today = forecast.today as { tMax: number; tMin: number; weatherText: string; precipProb: number };
  assert.equal(typeof today.tMax, "number");
  assert.equal(typeof today.tMin, "number");
  assert.equal(typeof today.weatherText, "string");
  assert.equal(typeof today.precipProb, "number");

  const air = await automationActions["airquality.current"].run({});
  assert.equal(typeof air.aqi, "number");
  assert.equal(typeof air.category, "string");
  assert.ok(air.scale === "CN" || air.scale === "US");
  assert.equal(typeof air.pm25, "number");
  assert.equal(typeof air.pm10, "number");

  const oil = await automationActions["oilprice.current"].run({});
  assert.equal(oil.province, "江西");
  assert.equal(typeof oil.p92, "number");
  assert.equal(typeof oil.p95, "number");
  assert.equal(typeof oil.p0, "number");
});
