import { z } from "zod";
import { store } from "../../core/store.js";
import { registerModule, ok, fail, type AssistantModule } from "../../core/registry.js";
import { queryExpress, detectCompany, type ExpressResult } from "./provider.js";

interface Tracked {
  company: string;
  number: string;
  phoneSuffix?: string;   // 手机号后四位（中通/顺丰/京东等必需）
  label?: string;         // 用户备注，如 "给妈妈的包裹"
  lastStatus?: string;    // 最近一次最新轨迹文本（用于 diff）
  createdAt: string;
}

const KEY = "express:tracked";

function getTracked(): Tracked[] {
  return store.get<Tracked[]>(KEY, [])!;
}

const trackSchema = {
  number: z.string().describe("快递单号"),
  company: z.string().optional().describe("快递公司代码（如 shunfeng/yuantong），不填则自动识别"),
  phoneSuffix: z.string().optional().describe("寄件人或收件人手机号后四位（顺丰/中通/京东等必需，否则可能查不到轨迹）"),
  label: z.string().optional().describe("包裹备注名"),
};

const expressModule: AssistantModule = {
  name: "express",
  tools: [
    {
      name: "track",
      description: "订阅一个快递单号的动态追踪。订阅后系统按 expressPoll cron（默认每小时）自动轮询，物流状态变更时主动通知用户。",
      schema: trackSchema,
      handler: async (args) => {
        try {
          const p = z.object(trackSchema).parse(args);
          const list = getTracked();
          if (list.some((t) => t.number === p.number)) return ok({ status: "already_tracked", number: p.number });
          // 立即查一次作为基线（TianAPI 自动识别公司；手机后四位用于中通/顺丰等）
          const first = await queryExpress(p.company ?? "", p.number, p.phoneSuffix);
          const company = p.company ?? first.company;
          list.push({
            company, number: p.number, phoneSuffix: p.phoneSuffix, label: p.label,
            lastStatus: first.traces[0]?.status, createdAt: new Date().toISOString(),
          });
          store.set(KEY, list);
          return ok({ status: "tracking", company, number: p.number, latest: first.traces[0] ?? null });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
    {
      name: "list",
      description: "查看当前所有追踪中的快递及其最新状态。",
      schema: {},
      handler: async () => ok({ count: getTracked().length, items: getTracked() }),
    },
    {
      name: "untrack",
      description: "取消追踪某个快递单号。",
      schema: { number: z.string() },
      handler: async (args) => {
        const { number } = z.object({ number: z.string() }).parse(args);
        store.set(KEY, getTracked().filter((t) => t.number !== number));
        return ok({ status: "removed", number });
      },
    },
    {
      name: "query",
      description: "立即查询某快递单号的最新完整物流轨迹（不订阅）。",
      schema: { number: z.string(), company: z.string().optional(), phoneSuffix: z.string().optional().describe("手机号后四位（中通/顺丰/京东等必需）") },
      handler: async (args) => {
        try {
          const p = z.object({ number: z.string(), company: z.string().optional(), phoneSuffix: z.string().optional() }).parse(args);
          return ok(await queryExpress(p.company ?? "", p.number, p.phoneSuffix));
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    },
  ],
  jobs: [
    {
      name: "poll",
      // 模块已封存（modules/index 未注册）：cron 固定在此，不再占用共享配置。
      cron: "0 * * * *",
      handler: async ({ notify }) => {
        const list = getTracked();
        for (const t of list) {
          let r: ExpressResult;
          try {
            r = await queryExpress(t.company, t.number, t.phoneSuffix);
          } catch {
            continue; // 单次失败下轮再试
          }
          const latest = r.traces[0]?.status;
          if (latest && latest !== t.lastStatus) {
            const name = t.label ? `${t.label}（${t.number}）` : t.number;
            await notify(
              r.state === "3" ? `📦 已签收：${name}` : `📦 物流更新：${name}`,
              `${latest}\n时间：${r.traces[0]?.time}`,
              `express:${t.number}:${latest}`,
            );
            t.lastStatus = latest;
          }
          // 签收后自动停止追踪
          if (r.state === "3") {
            store.set(KEY, getTracked().filter((x) => x.number !== t.number));
          }
        }
        store.set(KEY, list.filter((t) => getTracked().some((x) => x.number === t.number)));
      },
    },
  ],
};

// 2026-08-01 封存护栏：默认不注册，避免取消 modules/index.ts 中的注释后意外恢复；确需恢复时设置 EXPRESS_ENABLED=1。
if (process.env.EXPRESS_ENABLED === "1") {
  registerModule(expressModule);
} else {
  console.warn("[express] 模块已封存，未注册；如需恢复请设置 EXPRESS_ENABLED=1。");
}
