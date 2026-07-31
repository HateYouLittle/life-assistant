import { config } from "../../config.js";
import { httpJson } from "../../core/http.js";

export interface OilPrice {
  region: string;
  p92: string;  // 92# 元/升
  p95: string;
  p0: string;   // 0# 柴油
  updatedAt?: string;
}

/**
 * 油价 Provider。国内无官方免费 API，提供两级实现：
 * 1. 聚合数据（JUHE_KEY 配置后启用，低成本，约 0.01 元/次量级）；
 * 2. 未配置时返回引导信息。
 * 替换为其他数据源（如自有解析服务）只需实现本函数签名。
 */
export async function fetchOilPrice(city: string): Promise<OilPrice> {
  if (!config.juheKey) {
    return {
      region: city,
      p92: "未配置数据源",
      p95: "未配置数据源",
      p0: "未配置数据源",
      updatedAt: "请设置 JUHE_KEY 环境变量（聚合数据油价 API），或实现自定义 Provider",
    };
  }
  // 聚合数据按省份查询，城市→省份的映射简化处理：直接传城市名，接口容错
  const r = await httpJson<{
    resultcode: string;
    result?: Array<{ city: string; "92h": string; "95h": string; "0h": string }>;
  }>(`http://apis.juhe.cn/gnyj/query?key=${config.juheKey}`);
  const hit = r.result?.find((x) => city.includes(x.city) || x.city.includes(city));
  if (!hit) throw new Error(`油价接口未覆盖：${city}`);
  return { region: hit.city, p92: hit["92h"], p95: hit["95h"], p0: hit["0h"] };
}
