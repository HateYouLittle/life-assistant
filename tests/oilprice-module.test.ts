import assert from "node:assert/strict";
import test from "node:test";

import { getModules } from "../src/core/registry.js";
import { currentOilPriceResult, nextAdjustmentSummary } from "../src/modules/oilprice/index.js";
import type { JuheOilPrice, TianApiOilPrice } from "../src/modules/oilprice/provider.js";

test("current oil-price adapter preserves the flat MCP contract without internal fields", () => {
  const tianObservation: TianApiOilPrice = {
    adjustmentEvidence: true,
    province: "江西",
    unit: "元/升",
    provider: "TianAPI",
    source: "TianAPI 成品油市场数据",
    providerEffectiveDate: "2026-08-01",
    windowDate: "2026-07-31",
    nextWindowDate: "2026-08-14",
    fuels: {
      p92: { current: "7.93", previous: "7.38", change: "0.55" },
      p95: { current: "8.51", previous: "7.92", change: "0.59" },
      p0: { current: "7.69", previous: "7.12", change: "0.57" },
    },
  };
  const juheObservation: JuheOilPrice = {
    adjustmentEvidence: false,
    province: "江西",
    unit: "元/升",
    provider: "JUHE",
    source: "聚合数据当前油价",
    fuels: {
      p92: { current: "7.93" },
      p95: { current: "8.51" },
      p0: { current: "7.69" },
    },
  };

  assert.deepEqual(currentOilPriceResult(tianObservation), {
    region: "江西",
    p92: "7.93",
    p95: "8.51",
    p0: "7.69",
    updatedAt: "2026-08-01",
  });
  assert.deepEqual(currentOilPriceResult(juheObservation), {
    region: "江西",
    p92: "7.93",
    p95: "8.51",
    p0: "7.69",
  });
});

test("next adjustment tool data does not promise a fixed announcement time", () => {
  const summary = nextAdjustmentSummary(new Date("2026-08-07T01:00:00.000Z"));

  assert.deepEqual(summary, {
    date: "2026-08-14",
    effectiveAt: "2026-08-15T00:00:00+08:00",
    hoursUntil: 183,
    note: "调价于窗口日 24:00 生效；正式结果发布时间不固定，请以正式调价数据为准。",
  });
  assert.doesNotMatch(JSON.stringify(summary), /17:00|前一日|预计公告/);
});

test("oil-price watch remains daily at 09:00 in the Shanghai business timezone", () => {
  const module = getModules().find((candidate) => candidate.name === "oilprice");
  const job = module?.jobs?.find((candidate) => candidate.name === "watch");

  assert.equal(job?.cron, "0 9 * * *");
  assert.equal(job?.timezone, "Asia/Shanghai");
});
