import crypto from "node:crypto";
import { config } from "../../config.js";
import { httpJson } from "../../core/http.js";

export interface ExpressTrace {
  time: string;
  status: string; // 轨迹描述，如 "已签收"
}

export interface ExpressResult {
  company: string;   // 快递公司代码，如 shunfeng
  number: string;
  state: string;     // 0在途 1揽收 2疑难 3签收 4退签 5派件 6退回
  traces: ExpressTrace[];
}

/**
 * TianAPI status → 快递100 state 映射。
 * TianAPI: 0无轨迹 1已揽件 2在途中 3派件中 4已签收 5问题件 6问题件 7已关闭 10已退回 ...
 * 快递100: 0在途 1揽收 2疑难 3签收 4退签 5派件 6退回
 */
const TIAN_STATE: Record<number, string> = {
  0: "0",  // 无轨迹 → 在途
  1: "1",  // 已揽件
  2: "0",  // 在途中
  3: "5",  // 派件中
  4: "3",  // 已签收
  5: "2",  // 问题件
  6: "2",  // 问题件
  7: "3",  // 已关闭 → 视为终态
  10: "6", // 已退回
  11: "0", // 在途中
  12: "1", // 待揽件 → 揽收
};

interface TianExpressResponse {
  code: number;
  msg?: string;
  result?: {
    status?: number;
    updatetime?: string;
    kuaidiname?: string;
    enkuaidiname?: string;
    telephone?: string;
    list?: Array<{ time?: string; address?: string; content?: string; status?: string }>;
    details?: Array<{ time?: string; address?: string; content?: string; status?: string }>;
  };
}

/**
 * TianAPI（天行数据）快递查询。robin-assistant 同源 key，自动识别单号，
 * 顺丰/中通/京东等需传手机号后四位（senderphone）。
 */
export async function queryExpressTian(
  number: string,
  phoneSuffix?: string,
): Promise<ExpressResult> {
  if (!config.tianapiKey) throw new Error("未配置 TIANAPI_KEY");
  const params = new URLSearchParams({ key: config.tianapiKey, number });
  if (phoneSuffix) params.set("senderphone", phoneSuffix);
  const r = await httpJson<TianExpressResponse>(
    `https://apis.tianapi.com/kuaidi/index?${params.toString()}`,
  );
  if (r.code !== 200) throw new Error(r.msg ?? `TianAPI 快递查询失败 code=${r.code}`);
  const b = r.result;
  if (!b) throw new Error("TianAPI 快递响应缺少 result");
  const rawNodes = b.list ?? b.details ?? [];
  const rawStatus = b.status ?? (rawNodes[0]?.status ? Number(rawNodes[0].status) : 0);
  const state = TIAN_STATE[rawStatus] ?? "0";
  return {
    company: b.enkuaidiname ?? "",
    number,
    state,
    traces: rawNodes.map((n) => ({
      time: n.time ?? "",
      status: n.content ?? n.address ?? "",
    })),
  };
}

/**
 * 快递100 实时查询 API（免费额度，需 customer + key）。
 * 作为 TianAPI 未配置时的兜底。
 */
export async function queryExpressKuaidi100(company: string, number: string): Promise<ExpressResult> {
  const { customer, key } = config.kuaidi100;
  if (!customer || !key) {
    throw new Error("未配置快递100授权，请设置 KUAIDI100_CUSTOMER / KUAIDI100_KEY 环境变量");
  }
  const param = JSON.stringify({ com: company, num: number, resultv2: "1" });
  const sign = crypto.createHash("md5").update(param + key + customer).digest("hex").toUpperCase();
  const body = `customer=${customer}&sign=${sign}&param=${encodeURIComponent(param)}`;
  const r = await httpJson<{
    state: string;
    data?: Array<{ time: string; context: string }>;
    message?: string;
  }>("https://poll.kuaidi100.com/poll/query.do", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.data) throw new Error(`快递查询失败：${r.message ?? "未知错误"}`);
  return {
    company,
    number,
    state: r.state,
    traces: r.data.map((t) => ({ time: t.time, status: t.context })),
  };
}

/**
 * 统一查询入口：TianAPI 优先（有 key 且未指定 company 时自动识别），
 * 快递100 兜底（需 customer+key）。company 可选：TianAPI 支持自动识别。
 */
export async function queryExpress(
  company: string,
  number: string,
  phoneSuffix?: string,
): Promise<ExpressResult> {
  if (config.tianapiKey) {
    const r = await queryExpressTian(number, phoneSuffix);
    if (r.company) return r; // TianAPI 识别出公司 → 直接用
    // 识别不出但指定了 company → 补上
    if (company) return { ...r, company };
    return r;
  }
  if (!company) throw new Error("未配置 TIANAPI_KEY 且未指定快递公司，无法查询");
  return queryExpressKuaidi100(company, number);
}

/** 快递公司自动识别（快递100 免费接口；TianAPI 查询时无需此步骤） */
export async function detectCompany(number: string): Promise<string> {
  const { key } = config.kuaidi100;
  if (!key) throw new Error("未配置 KUAIDI100_KEY");
  const r = await httpJson<Array<{ comCode: string }>>(
    `https://www.kuaidi100.com/autonumber/auto?num=${number}&key=${key}`,
  );
  if (!r[0]?.comCode) throw new Error(`无法识别单号所属公司：${number}`);
  return r[0].comCode;
}
