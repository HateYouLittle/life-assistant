import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyWeatherAlertDedupeKeys,
  officialAlertNotification,
  weatherAlertIdentity,
} from "../src/modules/weather/notification.js";
import type { OfficialWeatherAlert, WeatherAlert } from "../src/modules/weather/provider.js";

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
