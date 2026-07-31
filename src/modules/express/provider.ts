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
 * 快递100 实时查询 API（免费额度，需 customer + key）。
 * 替换为快递鸟等其他数据源只需实现本函数签名。
 */
export async function queryExpress(company: string, number: string): Promise<ExpressResult> {
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

/** 快递公司自动识别（快递100 免费接口） */
export async function detectCompany(number: string): Promise<string> {
  const { key } = config.kuaidi100;
  if (!key) throw new Error("未配置 KUAIDI100_KEY");
  const r = await httpJson<Array<{ comCode: string }>>(
    `https://www.kuaidi100.com/autonumber/auto?num=${number}&key=${key}`,
  );
  if (!r[0]?.comCode) throw new Error(`无法识别单号所属公司：${number}`);
  return r[0].comCode;
}
