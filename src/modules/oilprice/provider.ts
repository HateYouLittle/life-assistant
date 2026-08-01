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
 * 城市 → 省份 映射（TianAPI 按省份查询）。覆盖江西省全部地级市 + 直辖市，
 * 其余城市回退 JUHE 或提示配置。
 */
const CITY_TO_PROVINCE: Record<string, string> = {
  南昌: "江西", 九江: "江西", 上饶: "江西", 抚州: "江西", 宜春: "江西",
  吉安: "江西", 赣州: "江西", 景德镇: "江西", 萍乡: "江西", 新余: "江西",
  鹰潭: "江西",
  北京: "北京", 上海: "上海", 天津: "天津", 重庆: "重庆",
  广州: "广东", 深圳: "广东", 东莞: "广东", 佛山: "广东", 珠海: "广东",
  杭州: "浙江", 宁波: "浙江", 温州: "浙江",
  南京: "江苏", 苏州: "江苏", 无锡: "江苏",
  武汉: "湖北", 长沙: "湖南", 成都: "四川", 郑州: "河南",
  济南: "山东", 青岛: "山东", 福州: "福建", 厦门: "福建",
  西安: "陕西", 昆明: "云南", 贵阳: "贵州", 合肥: "安徽",
  石家庄: "河北", 太原: "山西", 沈阳: "辽宁", 大连: "辽宁",
  长春: "吉林", 哈尔滨: "黑龙江", 兰州: "甘肃", 银川: "宁夏",
  西宁: "青海", 拉萨: "西藏", 乌鲁木齐: "新疆", 呼和浩特: "内蒙古",
  南宁: "广西", 海口: "海南",
};

/** 从城市名（如 "萍乡市安源区"）提取省份；失败返回 undefined */
function provinceOf(city: string): string | undefined {
  const trimmed = city.trim();
  // 直辖市 / 自治区后缀直接归一化
  for (const suffix of ["特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区", "自治区", "省", "市"]) {
    if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length);
  }
  // 逐级截短城市名匹配映射表："萍乡市安源区" → "萍乡市" → "萍乡"
  let probe = trimmed;
  while (probe.length >= 2) {
    const hit = CITY_TO_PROVINCE[probe];
    if (hit) return hit;
    probe = probe.slice(0, -1);
  }
  // 直接包含映射键
  for (const [cityName, province] of Object.entries(CITY_TO_PROVINCE)) {
    if (trimmed.includes(cityName)) return province;
  }
  return undefined;
}

/**
 * 油价 Provider。国内无官方免费 API，提供三级实现：
 * 1. TianAPI（TIANAPI_KEY 配置后启用，按省份查询，robin-assistant 同源）；
 * 2. 聚合数据（JUHE_KEY 配置后启用，低成本，约 0.01 元/次量级）；
 * 3. 未配置时返回引导信息。
 * 替换为其他数据源（如自有解析服务）只需实现本函数签名。
 */
export async function fetchOilPrice(city: string): Promise<OilPrice> {
  const province = provinceOf(city);
  // 1. TianAPI
  if (config.tianapiKey && province) {
    try {
      const r = await httpJson<{
        code: number;
        msg?: string;
        result?: { prov?: string; p0?: string | number; p92?: string | number; p95?: string | number; time?: string };
      }>(`https://apis.tianapi.com/oilprice/index?key=${config.tianapiKey}&prov=${encodeURIComponent(province)}`);
      if (r.code !== 200) throw new Error(r.msg ?? `TianAPI 返回 code=${r.code}`);
      const b = r.result;
      if (!b) throw new Error("TianAPI 油价响应缺少 result");
      return {
        region: b.prov ?? province,
        p92: String(b.p92 ?? "—"),
        p95: String(b.p95 ?? "—"),
        p0: String(b.p0 ?? "—"),
        updatedAt: b.time,
      };
    } catch (e) {
      // TianAPI 失败不回退静默，返回错误由上层 fail 暴露；但若无 JUHE 则直接抛
      if (!config.juheKey) throw e;
      console.error(`[oilprice] TianAPI 失败，回退 JUHE: ${(e as Error).message}`);
    }
  }
  // 2. 聚合数据
  if (config.juheKey) {
    const r = await httpJson<{
      resultcode: string;
      result?: Array<{ city: string; "92h": string; "95h": string; "0h": string }>;
    }>(`http://apis.juhe.cn/gnyj/query?key=${config.juheKey}`);
    const hit = r.result?.find((x) => city.includes(x.city) || x.city.includes(city));
    if (!hit) throw new Error(`油价接口未覆盖：${city}`);
    return { region: hit.city, p92: hit["92h"], p95: hit["95h"], p0: hit["0h"] };
  }
  // 3. 未配置
  return {
    region: city,
    p92: "未配置数据源",
    p95: "未配置数据源",
    p0: "未配置数据源",
    updatedAt: "请设置 TIANAPI_KEY 或 JUHE_KEY 环境变量，或实现自定义 Provider",
  };
}
