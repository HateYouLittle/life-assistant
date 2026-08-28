import assert from "node:assert/strict";
import test from "node:test";

import {
  registerNotificationBlocks,
  renderNotification,
  type NotificationEnvelope,
  type NotificationRenderTarget,
} from "../src/core/notification.js";
import {
  inferredAlertNotification,
  officialAlertNotification,
} from "../src/modules/weather/notification.js";
import type { InferredWeatherRisk, OfficialWeatherAlert } from "../src/modules/weather/provider.js";
import {
  advanceNoticeNotification,
  officialResultNotification,
} from "../src/modules/oilprice/notification.js";
import { buildScheduleReminderNotification } from "../src/modules/schedule/notification.js";
import type { ScheduleItem } from "../src/modules/schedule/types.js";

// 阶段 A：plain 输出黄金回归锁。
// 本文件只锁定当前实现的真实 plain 输出（期望字符串来自实际渲染结果，非臆造）。
// 阶段 B 的平台渲染重构完成后，此文件必须保持全绿——它是 plain 投影字节级不变的
// 核心闸门。任何重构若使黄金样例漂移，必须视为回归。
//
// 每个样例断言：
//   1. renderNotification(n, "plain") / 未知 target 二者 deepEqual（字节级锁定）；
//   2. 同一输入渲染两次结果 deepEqual（确定性）；
//   3. plain body 不含 "undefined"、空标签（"标签：\n"）、"—"。

interface GoldenCase {
  name: string;
  notification: NotificationEnvelope;
  expected: { title: string; body: string };
}

/** 所有会以 `标签：值` 形式出现的标签前缀；值不得为空（即不得出现 `标签：\n`）。 */
const LABEL_PREFIXES = [
  "时间", "区域", "风险", "建议", "来源",
  "当前", "今日", "降水",
  "调整时间", "正式涨跌", "提示",
  "生效时间", "地区", "92号汽油", "95号汽油", "0号柴油",
  "发生时间", "截止时间", "相对", "备注", "提醒",
] as const;

const scheduleItem: ScheduleItem = {
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

const fullOfficialAlert: OfficialWeatherAlert = {
  kind: "official",
  id: "202608041411009200029230",
  publisher: "江西省气象台",
  issuedAt: "2026-08-04T06:11:00Z",
  eventType: "雷电",
  eventCode: "1014",
  level: "橙色",
  severity: "severe",
  effectiveAt: "2026-08-04T06:11:00Z",
  onsetAt: "2026-08-04T06:11:00Z",
  expiresAt: "2026-08-04T11:11:00Z",
  headline: "官方标题原文",
  description: "江西省气象台2026年08月04日14时11分发布雷电橙色预警信号：预计未来2小时内多地有强雷电活动，请注意防范。",
  criteria: "2小时内发生雷电活动的可能性很大，出现雷电灾害事故的可能性比较大。",
  instruction: "密切关注天气，尽量避免户外活动。",
  attributions: ["国家预警信息发布中心"],
};

const areaLessOfficialAlert: OfficialWeatherAlert = {
  kind: "official",
  id: "alert:minimal-issued",
  publisher: "江西省气象台",
  issuedAt: "2026-08-04T06:11:00Z",
  eventType: "雷电",
  level: "橙色",
  severity: "severe",
  effectiveAt: "2026-08-04T06:11:00Z",
  headline: "官方标题原文",
  description: "",
  criteria: "发生雷电灾害事故的可能性较大。",
  attributions: ["国家预警信息发布中心"],
};

const goldenCases: GoldenCase[] = [
  {
    name: "weather.daily_brief：完整字段（当前+今日+降水+建议）",
    notification: {
      kind: "weather.daily_brief",
      identity: "daily-brief:2026-08-04",
      source: "weather",
      scope: { type: "global" },
      headline: "萍乡今天高温有阵雨，注意防晒带伞",
      generatedAt: "2026-08-04T07:00:00+08:00",
      payload: {
        city: "萍乡",
        current: {
          weather: "多云",
          temperatureC: 28,
          apparentTemperatureC: 30,
          humidityPercent: 61,
        },
        today: { weather: "阵雨", minTemperatureC: 24, maxTemperatureC: 35 },
        precipitation: { probabilityPercent: 70 },
        advice: "减少午后长时间户外活动，外出带伞",
      },
    },
    expected: {
      title: "萍乡今天高温有阵雨，注意防晒带伞",
      body: [
        "当前：多云，28℃，体感30℃，湿度61%",
        "今日：24～35℃，阵雨",
        "降水：最高概率70%",
        "建议：减少午后长时间户外活动，外出带伞",
      ].join("\n"),
    },
  },
  {
    name: "weather.daily_brief：缺失可选字段（仅 today）",
    notification: {
      kind: "weather.daily_brief",
      identity: "daily-brief:minimal",
      source: "weather",
      scope: { type: "global" },
      headline: "萍乡今日晴到多云",
      generatedAt: "2026-08-04T07:00:00+08:00",
      payload: {
        city: "萍乡",
        today: { weather: "晴", minTemperatureC: 25, maxTemperatureC: 33 },
      },
    },
    expected: {
      title: "萍乡今日晴到多云",
      body: ["今日：25～33℃，晴"].join("\n"),
    },
  },
  {
    name: "weather.official_alert：完整预警（时间/风险/建议/来源/官方原文，builder 构造）",
    notification: officialAlertNotification(fullOfficialAlert, {
      generatedAt: "2026-08-04T19:00:00+08:00",
      timezone: "Asia/Shanghai",
    }),
    expected: {
      title: "雷电橙色预警：2小时内发生雷电活动的可能性很大，出现雷电灾害事故的可能性比较大。",
      body: [
        "时间：江西省气象台于 2026年8月4日 14:11 发布；影响时段：2026年8月4日 14:11 至 2026年8月4日 19:11",
        "风险：2小时内发生雷电活动的可能性很大，出现雷电灾害事故的可能性比较大。",
        "建议：密切关注天气，尽量避免户外活动。",
        "来源：江西省气象台（和风天气）",
        "",
        "官方原文：",
        "江西省气象台2026年08月04日14时11分发布雷电橙色预警信号：预计未来2小时内多地有强雷电活动，请注意防范。",
      ].join("\n"),
    },
  },
  {
    name: "weather.official_alert：缺失区域（无 区域/建议/官方原文 行，builder 构造）",
    notification: officialAlertNotification(areaLessOfficialAlert, {
      generatedAt: "2026-08-04T19:00:00+08:00",
      timezone: "Asia/Shanghai",
    }),
    expected: {
      title: "雷电橙色预警：发生雷电灾害事故的可能性较大。",
      body: [
        "时间：江西省气象台于 2026年8月4日 14:11 发布；影响开始：2026年8月4日 14:11",
        "风险：发生雷电灾害事故的可能性较大。",
        "来源：江西省气象台（和风天气）",
      ].join("\n"),
    },
  },
  {
    name: "weather.inferred_alert：大风推断（builder 构造）",
    notification: inferredAlertNotification(
      {
        kind: "inferred",
        title: "萍乡大风推断提醒",
        level: "inferred",
        description: "未来48小时风速峰值约 19m/s（约8级），注意防风。",
      },
      { generatedAt: "2026-08-04T11:30:00.000Z", timezone: "Asia/Shanghai" },
    ),
    expected: {
      title: "系统推断风险：萍乡大风推断提醒",
      body: "未来48小时风速峰值约 19m/s（约8级），注意防风。",
    },
  },
  {
    name: "weather.inferred_alert：强降雨推断（builder 构造）",
    notification: inferredAlertNotification(
      {
        kind: "inferred",
        title: "萍乡强降雨推断提醒",
        level: "inferred",
        description: "未来48小时小时降水峰值约 32mm，可能达暴雨量级，注意出行安全。",
      },
      { generatedAt: "2026-08-05T03:00:00.000Z", timezone: "Asia/Shanghai" },
    ),
    expected: {
      title: "系统推断风险：萍乡强降雨推断提醒",
      body: "未来48小时小时降水峰值约 32mm，可能达暴雨量级，注意出行安全。",
    },
  },
  {
    name: "oilprice.advance_notice：2026-08-14 窗口（builder 构造）",
    notification: advanceNoticeNotification({
      windowDate: "2026-08-14",
      effectiveAt: "2026-08-15T00:00:00+08:00",
      generatedAt: "2026-08-13T09:00:00+08:00",
    }),
    expected: {
      title: "下一轮油价调整窗口：2026年8月14日",
      body: [
        "调整时间：2026年8月14日 24:00（北京时间）",
        "正式涨跌：尚未发布",
        "提示：如近期需要加油，请留意正式调价结果。",
      ].join("\n"),
    },
  },
  {
    name: "oilprice.advance_notice：2026-09-01 窗口（builder 构造）",
    notification: advanceNoticeNotification({
      windowDate: "2026-09-01",
      effectiveAt: "2026-09-02T00:00:00+08:00",
      generatedAt: "2026-08-31T09:00:00+08:00",
    }),
    expected: {
      title: "下一轮油价调整窗口：2026年9月1日",
      body: [
        "调整时间：2026年9月1日 24:00（北京时间）",
        "正式涨跌：尚未发布",
        "提示：如近期需要加油，请留意正式调价结果。",
      ].join("\n"),
    },
  },
  {
    name: "oilprice.official_result：全涨（builder 构造）",
    notification: officialResultNotification({
      province: "江西",
      windowDate: "2026-07-31",
      effectiveAt: "2026-08-01T00:00:00+08:00",
      generatedAt: "2026-08-01T09:00:00+08:00",
      provider: "TianAPI",
      source: "国家发展改革委调价数据",
      unit: "元/升",
      fuels: {
        p92: { current: "7.93", change: "0.55" },
        p95: { current: "8.51", change: "0.59" },
        p0: { current: "7.69", change: "0.57" },
      },
    }),
    expected: {
      title: "江西油价已上调，92号每升上涨0.55元",
      body: [
        "92号汽油：7.93元/升，每升上涨0.55元",
        "95号汽油：8.51元/升，每升上涨0.59元",
        "0号柴油：7.69元/升，每升上涨0.57元",
        "生效时间：2026年7月31日 24:00（北京时间）",
        "地区：江西",
        "来源：国家发展改革委调价数据（TianAPI）",
      ].join("\n"),
    },
  },
  {
    name: "oilprice.official_result：混合方向（builder 构造）",
    notification: officialResultNotification({
      province: "江西",
      windowDate: "2026-08-14",
      effectiveAt: "2026-08-15T00:00:00+08:00",
      generatedAt: "2026-08-15T09:00:00+08:00",
      provider: "TianAPI",
      source: "国家发展改革委调价数据",
      unit: "元/升",
      fuels: {
        p92: { current: "7.93", change: "0.55" },
        p95: { current: "8.51", change: "0.59" },
        p0: { current: "7.69", change: "-0.57" },
      },
    }),
    expected: {
      title: "江西油价调整结果已发布",
      body: [
        "92号汽油：7.93元/升，每升上涨0.55元",
        "95号汽油：8.51元/升，每升上涨0.59元",
        "0号柴油：7.69元/升，每升下降0.57元",
        "生效时间：2026年8月14日 24:00（北京时间）",
        "地区：江西",
        "来源：国家发展改革委调价数据（TianAPI）",
      ].join("\n"),
    },
  },
  {
    name: "oilprice.official_result：source 已含 provider（builder 构造）",
    notification: officialResultNotification({
      province: "江西",
      windowDate: "2026-07-31",
      effectiveAt: "2026-08-01T00:00:00+08:00",
      generatedAt: "2026-08-01T09:00:00+08:00",
      provider: "TianAPI",
      source: "TianAPI 成品油市场数据",
      unit: "元/升",
      fuels: {
        p92: { current: "7.93", change: "0.55" },
        p95: { current: "8.51", change: "0.59" },
        p0: { current: "7.69", change: "0.57" },
      },
    }),
    expected: {
      title: "江西油价已上调，92号每升上涨0.55元",
      body: [
        "92号汽油：7.93元/升，每升上涨0.55元",
        "95号汽油：8.51元/升，每升上涨0.59元",
        "0号柴油：7.69元/升，每升上涨0.57元",
        "生效时间：2026年7月31日 24:00（北京时间）",
        "地区：江西",
        "来源：TianAPI 成品油市场数据",
      ].join("\n"),
    },
  },
  {
    name: "schedule.reminder：完整字段·发生提醒（builder 构造）",
    notification: buildScheduleReminderNotification({
      item: scheduleItem,
      occurrenceKey: "2026-08-10T01:30:00.000Z:occurrence:two-hours",
      occurrenceAt: "2026-08-10T01:30:00.000Z",
      deadlineAt: "2026-08-10T13:30:00.000Z",
      target: "occurrence",
      reminderId: "two-hours",
      reminderMinutes: 120,
      generatedAt: "2026-08-09T23:30:00.000Z",
    }),
    expected: {
      title: "生日 · 发生提醒：妈妈生日",
      body: [
        "生日 · 发生提醒：妈妈生日",
        "发生时间：今天 09:30",
        "相对：还有 2 小时 0 分钟",
        "备注：提前订蛋糕",
      ].join("\n"),
    },
  },
  {
    name: "schedule.reminder：完整字段·截止提醒/纪念日（builder 构造）",
    notification: buildScheduleReminderNotification({
      item: { ...scheduleItem, type: "anniversary", title: "相识纪念日", note: undefined },
      occurrenceKey: "2026-08-10T01:30:00.000Z:deadline:due",
      occurrenceAt: "2026-08-10T01:30:00.000Z",
      deadlineAt: "2026-08-10T13:30:00.000Z",
      target: "deadline",
      reminderId: "due",
      reminderMinutes: 0,
      generatedAt: "2026-08-10T12:30:00.000Z",
    }),
    expected: {
      title: "纪念日 · 截止提醒：相识纪念日",
      body: [
        "纪念日 · 截止提醒：相识纪念日",
        "截止时间：今天 21:30",
        "相对：还有 1 小时 0 分钟",
      ].join("\n"),
    },
  },
  {
    name: "schedule.reminder：最小 payload（缺 targetAt/occurrenceAt/target/generatedAt）",
    notification: {
      kind: "schedule.reminder",
      identity: "profile-a:schedule-min:minimal",
      source: "schedule",
      scope: { type: "profile", profileId: "profile-a" },
      headline: "待办 · 发生提醒：还款",
      generatedAt: "2026-08-10T04:00:00.000Z",
      payload: {
        title: "还款",
        eventAt: "2026-08-10T12:00:00+08:00",
        timezone: "Asia/Shanghai",
        reminderMinutes: 30,
      },
    },
    expected: {
      title: "待办 · 发生提醒：还款",
      body: [
        "还款",
        "时间：2026-08-10 12:00",
        "提醒：提前 30 分钟",
      ].join("\n"),
    },
  },
];

const emptyLabelPattern = new RegExp(`(?:${LABEL_PREFIXES.join("|")})：\\n`);

for (const sample of goldenCases) {
  test(`plain 黄金锁：${sample.name}`, () => {
    // 1) plain / 未知 target 两路字节级一致，且等于黄金快照。
    const plain = renderNotification(sample.notification, "plain");
    assert.deepEqual(renderNotification(sample.notification, "unknown-target" as any), plain);
    assert.deepEqual(plain, sample.expected);
    assert.deepEqual(renderNotification(sample.notification), sample.expected);

    // 2) 确定性：同一输入渲染两次结果 deepEqual。
    assert.deepEqual(renderNotification(sample.notification), renderNotification(sample.notification));
    assert.deepEqual(plain, renderNotification(sample.notification, "plain"));

    // 3) plain body 质量不变量。
    assert.doesNotMatch(plain.body, /undefined/);
    assert.doesNotMatch(plain.body, /—/);
    assert.doesNotMatch(plain.body, emptyLabelPattern);
  });
}

test("plain 黄金锁：样例表覆盖全部 6 种 kind，且每种至少 2 个代表性 envelope", () => {
  const counts = new Map<string, number>();
  for (const sample of goldenCases) {
    counts.set(sample.notification.kind, (counts.get(sample.notification.kind) ?? 0) + 1);
  }
  const kinds = [
    "weather.daily_brief",
    "weather.official_alert",
    "weather.inferred_alert",
    "oilprice.advance_notice",
    "oilprice.official_result",
    "schedule.reminder",
  ] as const;
  for (const kind of kinds) {
    assert.ok((counts.get(kind) ?? 0) >= 2, `${kind} 至少需要 2 个黄金样例，当前 ${counts.get(kind) ?? 0} 个`);
  }
});

// ============================================================================
// 阶段 B：平台分支期望（TDD 红 → 绿）
//
// qq-markdown / feishu-markdown / wechat-markdown 现在必须产生平台投影：
//   - title = `# ` + headline；
//   - label 块 → `**标签**：值`；
//   - 块间空行（\n\n 分段）；
//   - raw 块原样（官方原文逐字出现，不解析不转义）；
//   - 省略与 headline 完全相同的首行（schedule.reminder 用例验证）；
//   - 无表格（|）、渲染器不新增 emoji（emoji 集合与 plain 相同或为空）；
//   - 两次渲染 deepEqual（确定性）。
// 未知 target 与 plain 完全一致（黄金锁已覆盖，此处重点抽查）。
// ============================================================================

const MARKDOWN_TARGETS = ["qq-markdown", "feishu-markdown", "wechat-markdown"] as const;

/** 提取文本中出现过的所有 emoji（按 Extended_Pictographic 属性），排序去重。 */
function emojiList(text: string): string[] {
  return [...text.matchAll(/\p{Extended_Pictographic}/gu)].map((match) => match[0]).sort();
}

/** 断言 markdown body 依序包含给定事实（indexOf 相对顺序），且无表格/无新增 emoji/确定性。 */
function assertMarkdownInvariants(
  sample: GoldenCase,
  rendered: { title: string; body: string },
  plainBody: string,
  facts: readonly string[],
): void {
  assert.equal(rendered.title, `# ${sample.notification.headline}`);
  const indices = facts.map((fact) => rendered.body.indexOf(fact));
  for (let i = 0; i < facts.length; i++) {
    assert.ok(indices[i] >= 0, `markdown body 必须包含事实「${facts[i]}」`);
  }
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `markdown 事实顺序不得翻转：${facts[i - 1]} 应在 ${facts[i]} 之前`);
  }
  assert.doesNotMatch(rendered.body, /\|/);
  assert.deepEqual(emojiList(rendered.body), emojiList(plainBody));
  for (const target of MARKDOWN_TARGETS) {
    assert.deepEqual(rendered, renderNotification(sample.notification, target));
  }
}

function dailyBriefFullSample(): GoldenCase {
  return goldenCases.find((c) => c.name.startsWith("weather.daily_brief：完整字段"))!;
}

function officialAlertFullSample(): GoldenCase {
  return goldenCases.find((c) => c.name.startsWith("weather.official_alert：完整预警"))!;
}

function scheduleReminderFullSample(): GoldenCase {
  return goldenCases.find((c) => c.name.startsWith("schedule.reminder：完整字段·发生提醒"))!;
}

function inferredAlertFullSample(): GoldenCase {
  return goldenCases.find((c) => c.name.startsWith("weather.inferred_alert：大风推断"))!;
}

test("平台分支：weather.daily_brief 在 qq/feishu/wechat 下标签加粗、数值单位与顺序与 plain 一致", () => {
  const sample = dailyBriefFullSample();
  const plain = renderNotification(sample.notification, "plain");
  for (const target of MARKDOWN_TARGETS) {
    const rendered = renderNotification(sample.notification, target);
    assertMarkdownInvariants(sample, rendered, plain.body, [
      "**当前**：多云，28℃，体感30℃，湿度61%",
      "**今日**：24～35℃，阵雨",
      "**降水**：最高概率70%",
      "**建议**：减少午后长时间户外活动，外出带伞",
    ]);
    for (const token of ["28℃", "30℃", "61%", "24～35℃"]) {
      assert.ok(rendered.body.includes(token), `body 应包含数值/单位「${token}」`);
    }
  }
  assert.deepEqual(
    renderNotification(sample.notification, "wechat-markdown"),
    renderNotification(sample.notification, "qq-markdown"),
  );
  assert.deepEqual(renderNotification(sample.notification, "unknown-platform" as any), plain);
});

test("平台分支：weather.official_alert 在 qq/feishu/wechat 下官方原文 raw 块原样出现", () => {
  const sample = officialAlertFullSample();
  const plain = renderNotification(sample.notification, "plain");
  const details = "江西省气象台2026年08月04日14时11分发布雷电橙色预警信号：预计未来2小时内多地有强雷电活动，请注意防范。";
  for (const target of MARKDOWN_TARGETS) {
    const rendered = renderNotification(sample.notification, target);
    assertMarkdownInvariants(sample, rendered, plain.body, [
      "**时间**：江西省气象台于 2026年8月4日 14:11 发布；影响时段：2026年8月4日 14:11 至 2026年8月4日 19:11",
      "**风险**：2小时内发生雷电活动的可能性很大，出现雷电灾害事故的可能性比较大。",
      "**建议**：密切关注天气，尽量避免户外活动。",
      "**来源**：江西省气象台（和风天气）",
      "官方原文：",
      details,
    ]);
    // 官方原文逐字出现（D7：raw 块不解析不转义）
    assert.ok(rendered.body.includes(details), "官方原文必须原样出现");
  }
  assert.deepEqual(
    renderNotification(sample.notification, "wechat-markdown"),
    renderNotification(sample.notification, "qq-markdown"),
  );
  assert.deepEqual(renderNotification(sample.notification, "unknown-platform" as any), plain);
});

test("平台分支：schedule.reminder 在 qq/feishu/wechat 下省略与 headline 相同的首行", () => {
  const sample = scheduleReminderFullSample();
  const plain = renderNotification(sample.notification, "plain");
  for (const target of MARKDOWN_TARGETS) {
    const rendered = renderNotification(sample.notification, target);
    assert.equal(rendered.title, "# 生日 · 发生提醒：妈妈生日");
    // 正文首行与 headline 完全相同 → 省略，仅保留 `# ` 标题
    assert.ok(
      !rendered.body.includes("生日 · 发生提醒：妈妈生日"),
      "markdown body 不得重复 headline 首行",
    );
    assertMarkdownInvariants(sample, rendered, plain.body, [
      "**发生时间**：今天 09:30",
      "**相对**：还有 2 小时 0 分钟",
      "**备注**：提前订蛋糕",
    ]);
  }
  assert.deepEqual(
    renderNotification(sample.notification, "wechat-markdown"),
    renderNotification(sample.notification, "qq-markdown"),
  );
  assert.deepEqual(renderNotification(sample.notification, "unknown-platform" as any), plain);
});

test("平台分支：weather.inferred_alert plain 逐字保留旧版 body，markdown 三平台统一加粗风险标签", () => {
  const sample = inferredAlertFullSample();
  const plain = renderNotification(sample.notification, "plain");
  assert.deepEqual(plain, sample.expected);
  assert.deepEqual(renderNotification(sample.notification, "unknown-platform" as any), plain);

  const qq = renderNotification(sample.notification, "qq-markdown");
  assert.equal(qq.title, "# 系统推断风险：萍乡大风推断提醒");
  assert.equal(qq.body, "**风险**：未来48小时风速峰值约 19m/s（约8级），注意防风。");
  assert.deepEqual(renderNotification(sample.notification, "feishu-markdown"), qq);
  assert.deepEqual(renderNotification(sample.notification, "wechat-markdown"), qq);

  const other = goldenCases.find((c) => c.name.startsWith("weather.inferred_alert：强降雨推断"))!;
  const otherQq = renderNotification(other.notification, "qq-markdown");
  assert.equal(otherQq.body, "**风险**：未来48小时小时降水峰值约 32mm，可能达暴雨量级，注意出行安全。");
  for (const target of MARKDOWN_TARGETS) {
    assert.deepEqual(renderNotification(other.notification, target), otherQq);
  }
});

test("平台分支：qq/feishu/wechat 三平台 markdown 完全同集（# + 加粗 + 空行）", () => {
  const samples = [
    dailyBriefFullSample(),
    officialAlertFullSample(),
    inferredAlertFullSample(),
    scheduleReminderFullSample(),
  ];
  const [baselineTarget, ...restTargets] = MARKDOWN_TARGETS;
  for (const sample of samples) {
    const baseline = renderNotification(sample.notification, baselineTarget);
    for (const target of restTargets) {
      assert.deepEqual(renderNotification(sample.notification, target), baseline);
    }
  }
});

test("平台分支 fallback：最小残缺 payload 遍历全部 4 个 target 恒不 throw 且返回 {title, body}", () => {
  const minimal = goldenCases.find((c) => c.name.startsWith("schedule.reminder：最小 payload"))!;
  const targets: NotificationRenderTarget[] = [
    "plain",
    "qq-markdown",
    "feishu-markdown",
    "wechat-markdown",
  ];
  for (const target of targets) {
    const rendered = renderNotification(minimal.notification, target);
    assert.equal(typeof rendered.title, "string");
    assert.equal(typeof rendered.body, "string");
    assert.ok(rendered.title.length > 0, `${target} title 不得为空`);
    assert.ok(rendered.body.length > 0, `${target} body 不得为空`);
  }
});

// ============================================================================
// L1/L33：未知 kind 的 fallbackBlocks 投影 + 抛错渲染器的绝对兜底
// ============================================================================

function fallbackEnvelope(kind: string, details: string | undefined): NotificationEnvelope {
  return {
    kind,
    identity: `${kind}:identity`,
    source: "test",
    scope: { type: "global" },
    headline: `headline-${kind}`,
    generatedAt: "2027-01-01T00:00:00.000Z",
    ...(details === undefined ? {} : { details }),
    payload: {},
  };
}

test("L33: unregistered kinds render the fallbackBlocks projection on plain and qq-markdown", () => {
  const envelope = fallbackEnvelope("no.such.kind", "原样保留的官方原文");
  // fallbackBlocks = [line(headline), raw(details)]：plain 为 headline 行 + raw details。
  assert.deepEqual(
    renderNotification(envelope, "plain"),
    { title: "headline-no.such.kind", body: "headline-no.such.kind\n原样保留的官方原文" },
  );
  // qq-markdown 省略与 headline 相同的首行，只保留 raw details。
  assert.deepEqual(
    renderNotification(envelope, "qq-markdown"),
    { title: "# headline-no.such.kind", body: "原样保留的官方原文" },
  );
});

test("L33: a registered kind whose renderer throws falls back to the plain projection without throwing", () => {
  const envelope = fallbackEnvelope("test.boom", "兜底正文");
  registerNotificationBlocks("test.boom", () => {
    throw new Error("boom");
  });
  const plainFallback = renderNotification(envelope, "plain");
  assert.deepEqual(plainFallback, { title: "headline-test.boom", body: "兜底正文" });
  assert.deepEqual(renderNotification(envelope, "qq-markdown"), plainFallback);
});

test("L1: a throwing renderer never escapes renderNotification on plain or any markdown target", () => {
  const envelope = fallbackEnvelope("test.renderer.throw", "兜底正文");
  registerNotificationBlocks("test.renderer.throw", () => {
    throw new Error("renderer exploded");
  });
  const expected = { title: envelope.headline, body: envelope.details ?? "" };
  const targets: NotificationRenderTarget[] = [
    "plain",
    "qq-markdown",
    "feishu-markdown",
    "wechat-markdown",
  ];
  for (const target of targets) {
    assert.doesNotThrow(() => renderNotification(envelope, target), `${target} 不得 throw`);
    assert.deepEqual(renderNotification(envelope, target), expected);
  }
});
