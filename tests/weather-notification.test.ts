import assert from "node:assert/strict";
import test from "node:test";

import { renderNotification } from "../src/core/notification.js";

import {
  inferredAlertNotification,
  legacyWeatherAlertDedupeKeys,
  officialAlertNotification,
  weatherAlertIdentity,
} from "../src/modules/weather/notification.js";
import type { InferredWeatherRisk, OfficialWeatherAlert, WeatherAlert } from "../src/modules/weather/provider.js";

function officialAlert(overrides: Partial<OfficialWeatherAlert> = {}): OfficialWeatherAlert {
  return {
    kind: "official",
    id: "provider-id-1",
    publisher: "江西省气象台",
    issuedAt: "2026-08-04T06:11Z",
    eventType: "雷电",
    eventCode: "1014",
    level: "橙色",
    severity: "severe",
    effectiveAt: "2026-08-04T06:11Z",
    onsetAt: "2026-08-04T06:11Z",
    expiresAt: "2026-08-04T11:11Z",
    headline: "官方标题原文",
    description: "官方完整原文，区域与本次具体风险只在这里。",
    criteria: "雷电灾害事故发生可能性较大。",
    instruction: "密切关注天气，尽量避免户外活动。",
    attributions: ["国家预警信息发布中心"],
    ...overrides,
  };
}

test("official alert identity prefers a stable provider ID", () => {
  assert.equal(weatherAlertIdentity(officialAlert()), "alert:id:provider-id-1");
  assert.equal(weatherAlertIdentity(officialAlert({ publisher: "不同发布机构" })), "alert:id:provider-id-1");
});

test("official alert legacy aliases use the raw headline across UTC midnight", () => {
  assert.deepEqual(
    legacyWeatherAlertDedupeKeys(
      officialAlert({ headline: "萍乡暴雨橙色预警 / 请注意" }),
      new Date("2026-08-05T00:03:00.000Z"),
    ),
    [
      "weather:alert:萍乡暴雨橙色预警 / 请注意:2026-08-05",
      "weather:alert:萍乡暴雨橙色预警 / 请注意:2026-08-04",
    ],
  );
});

test("inferred risk legacy aliases use the raw title for the same two UTC dates", () => {
  const alert: WeatherAlert = {
    kind: "inferred",
    title: "萍乡高温推断提醒 / 体感风险",
    level: "inferred",
    description: "未来48小时注意防暑。",
  };
  assert.deepEqual(
    legacyWeatherAlertDedupeKeys(alert, new Date("2026-08-05T00:03:00.000Z")),
    [
      "weather:alert:萍乡高温推断提醒 / 体感风险:2026-08-05",
      "weather:alert:萍乡高温推断提醒 / 体感风险:2026-08-04",
    ],
  );
});

test("official alert fallback identity changes when only issued time changes", () => {
  const first = officialAlert({ id: undefined });
  const repeated = officialAlert({ id: undefined });
  const later = officialAlert({ id: undefined, issuedAt: "2026-08-04T07:11Z" });
  assert.equal(weatherAlertIdentity(first), weatherAlertIdentity(repeated));
  assert.notEqual(weatherAlertIdentity(first), weatherAlertIdentity(later));
  assert.match(weatherAlertIdentity(first), /^alert:fallback:/);
});

test("official alert fallback identity requires a color warning level", () => {
  const alert = officialAlert({ id: undefined, level: undefined, severity: "severe" });
  assert.throws(
    () => weatherAlertIdentity(alert),
    /lacks provider ID and complete fallback identity fields/,
  );
});

test("official alert conversion never displays generic severity as a color warning level", () => {
  const notification = officialAlertNotification(
    officialAlert({ level: undefined, severity: "severe" }),
    { generatedAt: "2026-08-04T11:30:00Z", timezone: "Asia/Shanghai" },
  );
  assert.equal(notification.headline, "雷电预警：雷电灾害事故发生可能性较大。");
  assert.equal(notification.payload.level, undefined);
});

test("official alert conversion uses only structured summary fields and preserves the full original text", () => {
  const alert = officialAlert();
  const notification = officialAlertNotification(alert, {
    generatedAt: "2026-08-04T11:30:00Z",
    timezone: "Asia/Shanghai",
  });

  assert.equal(notification.kind, "weather.official_alert");
  assert.equal(notification.source, "weather");
  assert.equal(notification.headline, "雷电橙色预警：雷电灾害事故发生可能性较大。");
  assert.equal(notification.details, alert.description);
  assert.equal(notification.payload.area, undefined);
  assert.equal(notification.payload.risk, alert.criteria);
  assert.equal(notification.payload.advice, alert.instruction);
  assert.deepEqual(notification.provenance, { provider: "和风天气", publisher: "江西省气象台" });
});

const inferredWindAlert: InferredWeatherRisk = {
  kind: "inferred",
  title: "萍乡大风推断提醒",
  level: "inferred",
  description: "未来48小时风速峰值约 19m/s（约8级），注意防风。",
};

test("inferred alert conversion keeps structured fields and a stable daily identity", () => {
  const notification = inferredAlertNotification(inferredWindAlert, {
    generatedAt: "2026-08-04T11:30:00.000Z",
    timezone: "Asia/Shanghai",
  });

  assert.equal(notification.kind, "weather.inferred_alert");
  assert.equal(notification.source, "weather");
  assert.deepEqual(notification.scope, { type: "global" });
  assert.equal(
    notification.identity,
    "inferred:%E8%90%8D%E4%B9%A1%E5%A4%A7%E9%A3%8E%E6%8E%A8%E6%96%AD%E6%8F%90%E9%86%92:2026-08-04",
  );
  assert.equal(notification.headline, "系统推断风险：萍乡大风推断提醒");
  assert.equal(notification.generatedAt, "2026-08-04T11:30:00.000Z");
  assert.deepEqual(notification.payload, {
    title: "萍乡大风推断提醒",
    description: "未来48小时风速峰值约 19m/s（约8级），注意防风。",
    timezone: "Asia/Shanghai",
  });
});

test("inferred alert plain rendering keeps the legacy body verbatim without any prefix", () => {
  const notification = inferredAlertNotification(inferredWindAlert, {
    generatedAt: "2026-08-04T11:30:00.000Z",
    timezone: "Asia/Shanghai",
  });

  const rendered = renderNotification(notification, "plain");
  assert.equal(rendered.title, "系统推断风险：萍乡大风推断提醒");
  assert.equal(rendered.body, "未来48小时风速峰值约 19m/s（约8级），注意防风。");
});

test("inferred alert markdown rendering labels the risk and is identical across qq/feishu/wechat", () => {
  const notification = inferredAlertNotification(inferredWindAlert, {
    generatedAt: "2026-08-04T11:30:00.000Z",
    timezone: "Asia/Shanghai",
  });

  const qq = renderNotification(notification, "qq-markdown");
  assert.equal(qq.title, "# 系统推断风险：萍乡大风推断提醒");
  assert.equal(qq.body, "**风险**：未来48小时风速峰值约 19m/s（约8级），注意防风。");
  assert.deepEqual(renderNotification(notification, "feishu-markdown"), qq);
  assert.deepEqual(renderNotification(notification, "wechat-markdown"), qq);
  assert.deepEqual(renderNotification(notification, "plain"), {
    title: "系统推断风险：萍乡大风推断提醒",
    body: "未来48小时风速峰值约 19m/s（约8级），注意防风。",
  });
});
