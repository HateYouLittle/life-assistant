import { z } from "zod";
import { registerModule, ok, withTool, type AssistantModule } from "../../core/registry.js";
import { resolveLocation } from "../location/index.js";
import { fetchAirQuality } from "./provider.js";

export const airqualityModule: AssistantModule = {
  name: "airquality",
  tools: [
    withTool(
      {
        name: "current",
        description: "查询实时空气质量（AQI、等级与 PM2.5/PM10 等污染物浓度）。和风国标 AQI 优先；未配置 QWEATHER_KEY 时降级 Open-Meteo 美标 AQI，两种量表数值不可直接比较（返回的 scale 字段标注量表）。默认查询已保存位置；也可传 city 查询任意城市，临时查询不改变已保存位置。",
      },
      { city: z.string().optional().describe("城市名（可选），如 朔城区/北京；不传则查已保存位置") },
      async ({ city }) => {
        const loc = await resolveLocation(city);
        const air = await fetchAirQuality(loc.city, loc.lat, loc.lon);
        return ok({
          city: air.city,
          scale: air.scale,
          scaleLabel: air.scale === "CN" ? "国标 AQI（HJ 633）" : "美标 AQI（US EPA）",
          aqi: air.aqi,
          category: air.category,
          primary: air.primary,
          pollutants: air.pollutants,
          pollutantUnit: "μg/m³",
          observedAt: air.observedAt,
          source: air.source,
        });
      },
    ),
  ],
};

registerModule(airqualityModule);
