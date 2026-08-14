import { config } from "../../config.js";
import { currentLocation } from "../../core/location.js";
import { registerModule, ok, fail, type AssistantModule } from "../../core/registry.js";
import { fetchOilPrice, type OilPriceObservation } from "./provider.js";
import { nextWindow } from "./schedule.js";
import { runOilPriceWatch } from "./watch.js";

export interface CurrentOilPriceResult {
  region: string;
  p92: string;
  p95: string;
  p0: string;
  updatedAt?: string;
}

export function currentOilPriceResult(observation: OilPriceObservation): CurrentOilPriceResult {
  const result: CurrentOilPriceResult = {
    region: observation.province,
    p92: observation.fuels.p92.current,
    p95: observation.fuels.p95.current,
    p0: observation.fuels.p0.current,
  };
  if (observation.adjustmentEvidence) result.updatedAt = observation.providerEffectiveDate;
  return result;
}

export function nextAdjustmentSummary(at = new Date()) {
  const window = nextWindow(at);
  if (!window) return null;
  return {
    ...window,
    // 展示层保留 1 位小数，避免浮点误差；逻辑阈值使用精确值
    hoursUntil: Math.round(window.hoursUntil * 10) / 10,
    note: "调价于窗口日 24:00 生效；正式结果发布时间不固定，请以正式调价数据为准。",
  };
}

const oilpriceModule: AssistantModule = {
  name: "oilprice",
  tools: [
    {
      name: "current",
      description: "查询用户所在地当前油价（92#、95# 汽油与 0# 柴油，元/升）。",
      schema: {},
      handler: async () => {
        try {
          const loc = currentLocation();
          if (!loc) throw new Error("位置未确认，请先调用 location.get");
          return ok(currentOilPriceResult(await fetchOilPrice(loc.city, { province: loc.province })));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "next_adjustment",
      description: "查询下一次油价调整窗口、生效时间与倒计时。发改委每 10 个工作日一调。",
      schema: {},
      handler: async () => {
        const summary = nextAdjustmentSummary();
        if (!summary) return fail("年度窗口表未覆盖当前日期，请更新 src/modules/oilprice/schedule.ts");
        return ok(summary);
      },
    },
  ],
  jobs: [
    {
      name: "watch",
      cron: config.cron.oilWatch, // 默认每天 09:00
      timezone: "Asia/Shanghai",
      handler: async () => runOilPriceWatch(),
    },
  ],
};

registerModule(oilpriceModule);
