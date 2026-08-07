import assert from "node:assert/strict";
import test from "node:test";

import { publishNotification } from "../src/core/notification-publisher.js";
import { renderNotification } from "../src/core/notification.js";
import {
  advanceNoticeNotification,
  officialResultNotification,
} from "../src/modules/oilprice/notification.js";

test("advance notice gives only the window conclusion in its headline and makes no price prediction", () => {
  const notification = advanceNoticeNotification({
    windowDate: "2026-08-14",
    effectiveAt: "2026-08-15T00:00:00+08:00",
    generatedAt: "2026-08-13T09:00:00+08:00",
  });

  assert.equal(notification.kind, "oilprice.advance_notice");
  assert.equal(notification.identity, "advance:2026-08-14");
  assert.deepEqual(renderNotification(notification), {
    title: "下一轮油价调整窗口：2026年8月14日",
    body: [
      "调整时间：2026年8月14日 24:00（北京时间）",
      "正式涨跌：尚未发布",
      "提示：如近期需要加油，请留意正式调价结果。",
    ].join("\n"),
  });
  assert.doesNotMatch(renderNotification(notification).body, /预计.*(涨|跌)|17:00|公告时间/);
});

test("advance notice semantic publishing uses one stable identity for the window", async () => {
  const keys: string[] = [];
  for (const generatedAt of ["2026-08-13T09:00:00+08:00", "2026-08-14T09:00:00+08:00"]) {
    await publishNotification(advanceNoticeNotification({
      windowDate: "2026-08-14",
      effectiveAt: "2026-08-15T00:00:00+08:00",
      generatedAt,
    }), {
      publishGlobal: async (_source, _title, _body, dedupeKey) => { keys.push(dedupeKey); },
    });
  }

  assert.deepEqual(keys, ["oilprice:advance:2026-08-14", "oilprice:advance:2026-08-14"]);
});

test("official result uses a neutral headline for mixed directions and renders all three fuels", () => {
  const notification = officialResultNotification({
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
  });

  assert.equal(notification.identity, "result:江西:2026-08-14");
  const rendered = renderNotification(notification);
  assert.deepEqual(rendered, {
    title: "江西油价调整结果已发布",
    body: [
      "92号汽油：7.93元/升，每升上涨0.55元",
      "95号汽油：8.51元/升，每升上涨0.59元",
      "0号柴油：7.69元/升，每升下降0.57元",
      "生效时间：2026年8月14日 24:00（北京时间）",
      "地区：江西",
      "来源：国家发展改革委调价数据（TianAPI）",
    ].join("\n"),
  });
  assert.doesNotMatch(rendered.body, /2026年8月15日 00:00/);
});

test("official result headline states an increase when all three fuels rise", () => {
  const notification = officialResultNotification({
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
  });

  assert.equal(notification.headline, "江西油价已上调，92号每升上涨0.55元");
});

test("official result headline states a decrease when all three fuels fall", () => {
  const notification = officialResultNotification({
    province: "江西",
    windowDate: "2026-07-31",
    effectiveAt: "2026-08-01T00:00:00+08:00",
    generatedAt: "2026-08-01T09:00:00+08:00",
    provider: "TianAPI",
    source: "国家发展改革委调价数据",
    unit: "元/升",
    fuels: {
      p92: { current: "7.38", change: "-0.55" },
      p95: { current: "7.92", change: "-0.59" },
      p0: { current: "7.12", change: "-0.57" },
    },
  });

  assert.equal(notification.headline, "江西油价已下调，92号每升下降0.55元");
});

test("official result source omits a duplicate provider name", () => {
  const notification = officialResultNotification({
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
  });

  const sourceLine = renderNotification(notification).body.split("\n").at(-1);
  assert.equal(sourceLine, "来源：TianAPI 成品油市场数据");
});
