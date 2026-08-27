import assert from "node:assert/strict";
import test from "node:test";

import { renderNotification, type NotificationEnvelope } from "../src/core/notification.js";

// 渲染器已下放各业务模块：此处显式加载以完成 kind 注册（生产进程由 modules/index 全量加载）。
import "../src/modules/weather/notification.js";
import "../src/modules/schedule/notification.js";

test("daily weather rendering is deterministic and follows the weather decision order", () => {
  const notification: NotificationEnvelope = {
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
  };

  const expected = {
    title: "萍乡今天高温有阵雨，注意防晒带伞",
    body: [
      "当前：多云，28℃，体感30℃，湿度61%",
      "今日：24～35℃，阵雨",
      "降水：最高概率70%",
      "建议：减少午后长时间户外活动，外出带伞",
    ].join("\n"),
  };
  assert.deepEqual(renderNotification(notification), expected);
  assert.deepEqual(renderNotification(notification), expected);
  assert.doesNotMatch(expected.body, /油价|undefined|当前：\s*$|建议：\s*$/m);
});

test("official alert rendering keeps structured facts ahead of the complete official text", () => {
  const officialText = "江西省气象台2026年08月04日14时11分发布雷电橙色预警信号：预计未来2小时内多地有强雷电活动，请注意防范。";
  const notification: NotificationEnvelope = {
    kind: "weather.official_alert",
    identity: "alert:id:202608041411009200029230",
    source: "weather",
    scope: { type: "global" },
    headline: "雷电橙色预警：江西省气象台已发布",
    generatedAt: "2026-08-04T19:00:00+08:00",
    provenance: { provider: "和风天气 / 国家预警信息发布中心", publisher: "江西省气象台" },
    payload: {
      type: "雷电",
      level: "橙色",
      issuedAt: "2026-08-04T06:11:00Z",
      impactStartsAt: "2026-08-04T06:11:00Z",
      impactEndsAt: "2026-08-04T11:11:00Z",
      timezone: "Asia/Shanghai",
      risk: "2小时内发生雷电活动的可能性很大，出现雷电灾害事故的可能性比较大。",
      advice: "密切关注天气，尽量避免户外活动。",
    },
    details: officialText,
  };

  const rendered = renderNotification(notification);
  assert.equal(rendered.title, "雷电橙色预警：江西省气象台已发布");
  assert.equal(rendered.body, [
    "时间：江西省气象台于 2026年8月4日 14:11 发布；影响时段：2026年8月4日 14:11 至 2026年8月4日 19:11",
    "风险：2小时内发生雷电活动的可能性很大，出现雷电灾害事故的可能性比较大。",
    "建议：密切关注天气，尽量避免户外活动。",
    "来源：江西省气象台（和风天气 / 国家预警信息发布中心）",
    "",
    "官方原文：",
    officialText,
  ].join("\n"));
  assert.doesNotMatch(rendered.body, /区域：|undefined|—/);
  assert.ok(rendered.body.indexOf("时间：") < rendered.body.indexOf("风险："));
  assert.ok(rendered.body.indexOf("风险：") < rendered.body.indexOf("建议："));
  assert.ok(rendered.body.indexOf("建议：") < rendered.body.indexOf("来源："));
  assert.ok(rendered.body.indexOf("来源：") < rendered.body.indexOf("官方原文："));
  assert.equal(rendered.body.slice(rendered.body.indexOf(officialText)), officialText);
});

test("an available structured area is rendered between time and risk", () => {
  const notification: NotificationEnvelope = {
    kind: "weather.official_alert",
    identity: "alert:id:area-order",
    source: "weather",
    scope: { type: "global" },
    headline: "雷电橙色预警：发生雷电灾害事故的可能性较大",
    generatedAt: "2026-08-04T19:00:00+08:00",
    provenance: { publisher: "江西省气象台" },
    payload: {
      type: "雷电",
      level: "橙色",
      issuedAt: "2026-08-04T06:11:00Z",
      timezone: "Asia/Shanghai",
      area: "南昌、萍乡",
      risk: "发生雷电灾害事故的可能性较大。",
    },
  };

  const body = renderNotification(notification).body;
  assert.ok(body.indexOf("时间：") < body.indexOf("区域：南昌、萍乡"));
  assert.ok(body.indexOf("区域：南昌、萍乡") < body.indexOf("风险："));
});
