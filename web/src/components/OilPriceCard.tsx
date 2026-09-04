import React from "react";
import {
  CalendarClock,
  Clock,
  Fuel,
  Info,
  TrendingUp,
} from "lucide-react";
import type { OilPriceData } from "../types";
import { cn } from "../utils";

interface OilPriceCardProps {
  data: OilPriceData | null;
  loading?: boolean;
}

export const OilPriceCard: React.FC<OilPriceCardProps> = ({ data, loading }) => {
  const { current, nextAdjustment, location } = data || {};
  const regionName = current?.region || location?.province || location?.city || "本地";

  // Countdown calculations (plain calculation, no conditional hook)
  const getCountdown = () => {
    if (!nextAdjustment) return null;
    const hours = nextAdjustment.hoursUntil;
    if (hours <= 0) return { number: "0", unit: "已生效", desc: "新周期开始" };
    if (hours < 24) {
      return { number: String(Math.round(hours)), unit: "小时", desc: "即将生效" };
    }
    const days = Math.floor(hours / 24);
    return { number: String(days), unit: "天", desc: `约 ${Math.round(hours)} 小时` };
  };
  const countdownText = getCountdown();

  if (loading && !data) {
    return (
      <div className="col-span-1 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 animate-pulse flex flex-col gap-4 shadow-lg min-h-[280px]">
        <div className="h-6 w-32 bg-zinc-800 rounded-md" />
        <div className="grid grid-cols-3 gap-2">
          <div className="h-20 bg-zinc-800/60 rounded-xl" />
          <div className="h-20 bg-zinc-800/60 rounded-xl" />
          <div className="h-20 bg-zinc-800/60 rounded-xl" />
        </div>
        <div className="h-24 bg-zinc-800/40 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="col-span-1 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 hover:border-zinc-700/80 transition-all shadow-lg flex flex-col justify-between gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
            <Fuel className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white tracking-tight">
                油价与调价窗口
              </h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-amber-300/90 font-medium border border-zinc-700/50">
                {regionName}
              </span>
            </div>
            <p className="text-xs text-zinc-400">发改委成品油价格监测</p>
          </div>
        </div>
      </div>

      {/* Fuel Prices 3-Column */}
      <div className="grid grid-cols-3 gap-2.5">
        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3 flex flex-col items-center justify-center text-center">
          <span className="text-xs font-semibold text-zinc-400">92# 汽油</span>
          <div className="my-1.5 flex items-baseline justify-center gap-0.5">
            <span className="text-xs text-amber-400 font-bold">¥</span>
            <span className="text-xl sm:text-2xl font-bold tracking-tight text-amber-400">
              {current?.p92 || "--"}
            </span>
          </div>
          <span className="text-[10px] text-zinc-400">元/升</span>
        </div>

        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3 flex flex-col items-center justify-center text-center">
          <span className="text-xs font-semibold text-zinc-400">95# 汽油</span>
          <div className="my-1.5 flex items-baseline justify-center gap-0.5">
            <span className="text-xs text-amber-300 font-bold">¥</span>
            <span className="text-xl sm:text-2xl font-bold tracking-tight text-amber-300">
              {current?.p95 || "--"}
            </span>
          </div>
          <span className="text-[10px] text-zinc-400">元/升</span>
        </div>

        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3 flex flex-col items-center justify-center text-center">
          <span className="text-xs font-semibold text-zinc-400">0# 柴油</span>
          <div className="my-1.5 flex items-baseline justify-center gap-0.5">
            <span className="text-xs text-zinc-300 font-bold">¥</span>
            <span className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-200">
              {current?.p0 || "--"}
            </span>
          </div>
          <span className="text-[10px] text-zinc-400">元/升</span>
        </div>
      </div>

      {/* Next Adjustment Section */}
      <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-3.5 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <CalendarClock className="w-4 h-4 text-amber-400" />
            <span>下轮调价生效日</span>
          </div>
          <span className="text-xs font-semibold text-zinc-200">
            {nextAdjustment?.date || "待公布"} 24:00
          </span>
        </div>

        {/* Big Countdown */}
        <div className="flex items-center justify-between bg-zinc-900/80 rounded-lg px-3 py-2 border border-zinc-800">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs text-zinc-400">倒计时</span>
            <span className="text-2xl font-bold tracking-tight text-amber-400 font-mono">
              {countdownText?.number ?? "--"}
            </span>
            <span className="text-xs font-medium text-zinc-300">
              {countdownText?.unit ?? ""}
            </span>
          </div>
          <div className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
            <TrendingUp className="w-3 h-3" />
            <span>10 工作日机制</span>
          </div>
        </div>

        {/* Note */}
        <div className="flex items-start gap-1.5 text-[11px] text-zinc-400 leading-tight">
          <Info className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" />
          <span>
            {nextAdjustment?.note || "调价窗口于窗口日 24:00 生效，请以发改委官方公告为准。"}
          </span>
        </div>
      </div>
    </div>
  );
};
