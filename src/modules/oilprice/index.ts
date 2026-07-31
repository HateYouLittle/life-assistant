import { config } from "../../config.js";
import { currentLocation } from "../../core/location.js";
import { registerModule, ok, fail, type AssistantModule } from "../../core/registry.js";
import { fetchOilPrice } from "./provider.js";
import { nextWindow } from "./schedule.js";

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
          return ok(await fetchOilPrice(loc.city));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "next_adjustment",
      description: "查询下一次油价调整窗口：生效日期、预计公告时间与倒计时。发改委每 10 个工作日一调。",
      schema: {},
      handler: async () => {
        const w = nextWindow();
        if (!w) return fail("年度窗口表未覆盖当前日期，请更新 oilprice/schedule.ts");
        return ok({ ...w, note: "调价于窗口日 24:00 生效，通常前一日 17:00 左右发改委发布公告" });
      },
    },
  ],
  jobs: [
    {
      name: "watch",
      cron: config.cron.oilWatch, // 默认每天 09:00
      handler: async ({ notify }) => {
        const w = nextWindow();
        if (!w) return;
        const day = new Date().toISOString().slice(0, 10);
        if (w.hoursUntil <= 40) {
          // 距离生效不足 40 小时（即明天夜里调价）→ 预通知，提醒加油
          await notify(
            "⛽ 油价调整预通知",
            `新一轮油价调整将于 ${w.date} 24:00 生效（约 ${Math.round(w.hoursUntil)} 小时后），预计今日 17:00 左右发布公告。如需加油请关注调价方向，或提前加满。`,
            `oilprice:adjust:${w.date}:${day}`,
          );
        }
      },
    },
  ],
};

registerModule(oilpriceModule);
