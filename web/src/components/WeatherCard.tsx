import React, { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Car,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudDrizzle,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Eye,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Shirt,
  Sparkles,
  Sun,
  Umbrella,
  Wind,
} from "lucide-react";
import type { WeatherAlert, WeatherData } from "../types";
import { cn } from "../utils";

interface WeatherCardProps {
  data: WeatherData | null;
  loading?: boolean;
  onRetry?: () => void;
}

export const WeatherCard: React.FC<WeatherCardProps> = ({
  data,
  loading,
  onRetry,
}) => {
  const [alertsExpanded, setAlertsExpanded] = useState(false);

  const { location, current, forecast, airQuality, alerts, indices } = data || {};
  const todayForecast = forecast?.[0];

  // 带伞建议 (plain calculation, avoid conditional hook)
  const getNeedUmbrella = () => {
    if (todayForecast) {
      if ((todayForecast.precipProb ?? 0) >= 60) return true;
      if ((todayForecast.precipAmountMm ?? 0) >= 1) return true;
      if (/雨/.test(todayForecast.weatherText)) return true;
    }
    if (current && /雨/.test(current.weatherText)) return true;
    return false;
  };
  const needUmbrella = getNeedUmbrella();

  // AQI color and category (plain calculation, avoid conditional hook)
  const getAqiInfo = () => {
    if (!airQuality) return null;
    const aqi = airQuality.aqi;
    let color = "text-emerald-400";
    let bg = "bg-emerald-500";
    let border = "border-emerald-500/30";
    let badgeBg = "bg-emerald-500/15";

    if (aqi > 200) {
      color = "text-purple-400";
      bg = "bg-purple-500";
      border = "border-purple-500/30";
      badgeBg = "bg-purple-500/15";
    } else if (aqi > 150) {
      color = "text-rose-400";
      bg = "bg-rose-500";
      border = "border-rose-500/30";
      badgeBg = "bg-rose-500/15";
    } else if (aqi > 100) {
      color = "text-amber-400";
      bg = "bg-amber-500";
      border = "border-amber-500/30";
      badgeBg = "bg-amber-500/15";
    } else if (aqi > 50) {
      color = "text-lime-400";
      bg = "bg-lime-500";
      border = "border-lime-500/30";
      badgeBg = "bg-lime-500/15";
    }

    return { aqi, color, bg, border, badgeBg, category: airQuality.category };
  };
  const aqiInfo = getAqiInfo();

  if (loading && !data) {
    return (
      <div className="col-span-1 md:col-span-2 lg:col-span-2 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-6 animate-pulse flex flex-col gap-6 shadow-lg">
        <div className="h-6 w-36 bg-zinc-800 rounded-md" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="h-28 bg-zinc-800/60 rounded-xl" />
          <div className="h-28 bg-zinc-800/60 rounded-xl" />
          <div className="h-28 bg-zinc-800/60 rounded-xl" />
        </div>
        <div className="h-20 bg-zinc-800/40 rounded-xl" />
      </div>
    );
  }

  if (!data || data.error === "location_not_set" || (!data.current && !data.forecast)) {
    return (
      <div className="col-span-1 md:col-span-2 lg:col-span-2 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-6 shadow-lg flex flex-col items-center justify-center min-h-[260px] text-center gap-3">
        <MapPin className="w-8 h-8 text-zinc-600 animate-bounce" />
        <p className="text-zinc-300 font-medium">尚未配置城市或获取天气失败</p>
        <p className="text-xs text-zinc-500">
          {data?.error === "location_not_set" ? "请先在后台配置所在地城市" : "网络暂不可达或接口未返回"}
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" /> 重新获取
          </button>
        )}
      </div>
    );
  }

  // Icon mapping
  const getWeatherIcon = (text: string = "", size = "w-6 h-6") => {
    if (/雷/.test(text)) return <CloudLightning className={cn(size, "text-amber-400")} />;
    if (/雪/.test(text)) return <CloudSnow className={cn(size, "text-sky-200")} />;
    if (/大雨|暴雨/.test(text)) return <CloudRain className={cn(size, "text-sky-500")} />;
    if (/小雨|阵雨|毛毛雨|雨/.test(text)) return <CloudDrizzle className={cn(size, "text-sky-400")} />;
    if (/多云|阴/.test(text)) return <CloudSun className={cn(size, "text-sky-300")} />;
    if (/晴/.test(text)) return <Sun className={cn(size, "text-amber-400")} />;
    return <Cloud className={cn(size, "text-zinc-400")} />;
  };

  const getIndexIcon = (name: string) => {
    if (name.includes("穿衣")) return <Shirt className="w-4 h-4 text-indigo-400" />;
    if (name.includes("紫外线")) return <Eye className="w-4 h-4 text-amber-400" />;
    if (name.includes("洗车")) return <Car className="w-4 h-4 text-sky-400" />;
    if (name.includes("运动")) return <Activity className="w-4 h-4 text-emerald-400" />;
    return <Sparkles className="w-4 h-4 text-zinc-400" />;
  };

  return (
    <div className="col-span-1 md:col-span-2 lg:col-span-2 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 hover:border-zinc-700/80 transition-all shadow-lg flex flex-col justify-between gap-5">
      {/* Top Bar: Location & Header & Umbrella Advice */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/60 pb-3.5">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
            <CloudSun className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white tracking-tight">
                天候与空气质量
              </h2>
              {location && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 flex items-center gap-1 border border-zinc-700/50">
                  <MapPin className="w-3 h-3 text-sky-400" />
                  {location.city}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400">
              {todayForecast
                ? `今天 ${todayForecast.weatherText}，${todayForecast.tMin} ~ ${todayForecast.tMax}℃`
                : current?.weatherText || "气象监测站"}
            </p>
          </div>
        </div>

        {/* Umbrella Badge */}
        <div
          className={cn(
            "px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-1.5 transition-all",
            needUmbrella
              ? "bg-sky-500/15 text-sky-300 border-sky-500/40 shadow-sm shadow-sky-500/10 animate-pulse"
              : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
          )}
        >
          {needUmbrella ? (
            <>
              <Umbrella className="w-3.5 h-3.5 text-sky-400" />
              <span>外出记得带伞</span>
            </>
          ) : (
            <>
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>无需带伞 · 天晴</span>
            </>
          )}
        </div>
      </div>

      {/* Weather Alert Flashing Bar (if any) */}
      {alerts && alerts.length > 0 && (
        <div className="bg-rose-950/40 border border-rose-500/40 rounded-xl p-3 text-xs text-rose-200 shadow-lg shadow-rose-950/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 animate-bounce" />
              <span className="font-semibold text-rose-300">
                {alerts[0].kind === "official"
                  ? alerts[0].headline
                  : alerts[0].title}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-300 font-bold border border-rose-500/30">
                {alerts[0].kind === "official" ? alerts[0].level || "预警" : "气象风险"}
              </span>
            </div>
            <button
              onClick={() => setAlertsExpanded(!alertsExpanded)}
              className="text-rose-400 hover:text-rose-200 transition-colors flex items-center gap-1"
            >
              <span>{alertsExpanded ? "收起" : "详情"}</span>
              {alertsExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
          {alertsExpanded && (
            <div className="mt-2.5 pt-2 border-t border-rose-500/20 text-rose-300/90 leading-relaxed text-[11px] whitespace-pre-wrap">
              {alerts[0].description}
            </div>
          )}
        </div>
      )}

      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Current Weather Tile */}
        <div className="bg-zinc-950/50 border border-zinc-800/60 rounded-xl p-4 flex flex-col justify-between gap-3">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-xs text-zinc-400">实时气温</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-4xl lg:text-5xl font-bold tracking-tight text-white">
                  {current ? Math.round(current.temperature) : "--"}
                </span>
                <span className="text-xl font-medium text-zinc-400">°C</span>
              </div>
            </div>
            <div className="flex flex-col items-end">
              {getWeatherIcon(current?.weatherText || todayForecast?.weatherText, "w-8 h-8")}
              <span className="text-xs text-zinc-300 mt-1 font-medium">
                {current?.weatherText || todayForecast?.weatherText || "晴"}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-zinc-800/50 text-xs text-zinc-400">
            <div className="flex items-center gap-1.5">
              <Droplets className="w-3.5 h-3.5 text-sky-400" />
              <span>湿度 {current?.humidity ?? "--"}%</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Wind className="w-3.5 h-3.5 text-teal-400" />
              <span>
                {current?.windSpeed ?? "--"} {current?.windSpeedUnit ?? "km/h"}
              </span>
            </div>
          </div>
        </div>

        {/* AQI Tile */}
        <div className="bg-zinc-950/50 border border-zinc-800/60 rounded-xl p-4 flex flex-col justify-between gap-3">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-zinc-400">空气质量</span>
                <span className="text-[10px] px-1 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                  {airQuality?.scale === "US" ? "美标" : "国标"}
                </span>
              </div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className={cn("text-4xl font-bold tracking-tight", aqiInfo?.color || "text-emerald-400")}>
                  {airQuality ? airQuality.aqi : "--"}
                </span>
                {aqiInfo && (
                  <span
                    className={cn(
                      "px-2 py-0.5 rounded-full text-xs font-semibold border",
                      aqiInfo.badgeBg,
                      aqiInfo.color,
                      aqiInfo.border
                    )}
                  >
                    {aqiInfo.category}
                  </span>
                )}
              </div>
            </div>
            <Activity className={cn("w-6 h-6", aqiInfo?.color || "text-emerald-400")} />
          </div>

          {/* AQI Progress Bar */}
          <div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-500", aqiInfo?.bg || "bg-emerald-500")}
                style={{
                  width: `${Math.min(100, ((airQuality?.aqi ?? 0) / 250) * 100)}%`,
                }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-2">
              <span>PM2.5: {airQuality?.pollutants?.pm25 ?? "--"}</span>
              <span>PM10: {airQuality?.pollutants?.pm10 ?? "--"}</span>
              {airQuality?.primary && (
                <span className="text-zinc-400">首要: {airQuality.primary}</span>
              )}
            </div>
          </div>
        </div>

        {/* Life Indices Quick Grid */}
        <div className="bg-zinc-950/50 border border-zinc-800/60 rounded-xl p-3.5 flex flex-col justify-between gap-2">
          <span className="text-xs text-zinc-400 font-medium">今日生活指数</span>
          <div className="grid grid-cols-2 gap-2">
            {(() => {
              const list = Array.isArray(indices) ? indices : (indices as any)?.indices || [];
              return list.length > 0 ? (
                list.slice(0, 4).map((idx: any, i: number) => (
                  <div
                    key={i}
                    className="bg-zinc-900/80 border border-zinc-800 rounded-lg p-2 flex items-center gap-2 text-xs"
                  >
                    {getIndexIcon(idx.name)}
                    <div className="overflow-hidden">
                      <p className="text-zinc-300 font-medium truncate">{idx.name}</p>
                      <p className="text-[11px] text-emerald-400 font-semibold">{idx.category}</p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="col-span-2 text-center py-4 text-xs text-zinc-400">
                  生活指数暂未发布
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* 7-Day Forecast Strip */}
      {forecast && forecast.length > 0 && (
        <div className="border-t border-zinc-800/60 pt-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-400">未来 7 天天气预报</span>
            <span className="text-[11px] text-zinc-400">低 / 高气温 (℃)</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
            {forecast.slice(0, 7).map((day, i) => {
              const d = new Date(day.date);
              const weekLabel = i === 0 ? "今天" : i === 1 ? "明天" : ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
              return (
                <div
                  key={day.date}
                  className={cn(
                    "flex flex-col items-center justify-between p-2 rounded-xl border text-xs transition-all",
                    i === 0
                      ? "bg-zinc-950/80 border-sky-500/30 text-white"
                      : "bg-zinc-950/40 border-zinc-800/60 text-zinc-300 hover:bg-zinc-950/60"
                  )}
                >
                  <span className="text-[11px] text-zinc-400 font-medium">{weekLabel}</span>
                  <div className="my-1">{getWeatherIcon(day.weatherText, "w-5 h-5")}</div>
                  <span className="text-[11px] text-zinc-300 truncate max-w-[50px]">
                    {day.weatherText}
                  </span>
                  <div className="flex items-center gap-1 text-[11px] font-mono mt-1">
                    <span className="text-sky-400">{day.tMin}°</span>
                    <span className="text-zinc-600">/</span>
                    <span className="text-amber-400">{day.tMax}°</span>
                  </div>
                  {day.precipProb !== undefined && day.precipProb > 0 && (
                    <span className="mt-1 px-1 rounded text-[9px] bg-sky-500/20 text-sky-300 font-medium">
                      {day.precipProb}%
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
