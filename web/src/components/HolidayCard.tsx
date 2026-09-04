import React, { useState } from "react";
import {
  AlertCircle,
  Calendar,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Clock,
  Sparkles,
} from "lucide-react";
import type { HolidayData } from "../types";
import { cn } from "../utils";

interface HolidayCardProps {
  data: HolidayData | null;
  loading?: boolean;
}

export const HolidayCard: React.FC<HolidayCardProps> = ({ data, loading }) => {
  const [showAllHolidays, setShowAllHolidays] = useState(false);

  if (loading && !data) {
    return (
      <div className="col-span-1 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 animate-pulse flex flex-col gap-4 shadow-lg min-h-[280px]">
        <div className="h-6 w-32 bg-zinc-800 rounded-md" />
        <div className="h-24 bg-zinc-800/60 rounded-xl" />
        <div className="h-20 bg-zinc-800/40 rounded-xl" />
      </div>
    );
  }

  const { next, year } = data || {};
  const currentYear = year?.year || new Date().getFullYear();

  return (
    <div className="col-span-1 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 hover:border-zinc-700/80 transition-all shadow-lg flex flex-col justify-between gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white tracking-tight">
                法定节假日与调休
              </h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-purple-300 font-medium border border-zinc-700/50">
                {currentYear}年
              </span>
            </div>
            <p className="text-xs text-zinc-400">国务院节假日放假安排</p>
          </div>
        </div>
      </div>

      {/* Hero Holiday Countdown */}
      {next ? (
        <div className="bg-gradient-to-br from-purple-950/40 via-zinc-950/60 to-zinc-950/80 border border-purple-500/20 rounded-xl p-4 flex flex-col gap-2.5 shadow-md">
          <div className="flex items-center justify-between">
            <span className="text-xs text-purple-300/80 font-medium flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              {next.status === "ongoing"
                ? `正在 ${next.holidayName} 假期中`
                : `下一个节假日 · ${next.holidayName}`}
            </span>
            <span
              className={cn(
                "text-[10px] font-semibold px-2 py-0.5 rounded-full border",
                next.status === "ongoing"
                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30 animate-pulse"
                  : "bg-purple-500/20 text-purple-300 border-purple-500/30"
              )}
            >
              {next.status === "ongoing" ? "放假中" : `连休 ${next.days} 天`}
            </span>
          </div>

          <div className="flex items-baseline gap-2 my-1">
            <span className="text-xs text-zinc-400">
              {next.status === "ongoing" ? "剩余" : "距放假还有"}
            </span>
            <span className="text-4xl font-bold tracking-tight text-purple-400 font-mono">
              {next.status === "ongoing" ? next.remainingDays : next.countdownDays}
            </span>
            <span className="text-sm font-semibold text-zinc-300">天</span>
          </div>

          <div className="flex items-center justify-between text-xs text-zinc-400 pt-2 border-t border-zinc-800/60">
            <span>
              {next.startDate} 至 {next.endDate}
            </span>
            <span>共 {next.days} 天</span>
          </div>

          {/* Make-Up Workdays Alert */}
          {next.makeUpWorkdays && next.makeUpWorkdays.length > 0 && (
            <div className="mt-1 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5 text-xs text-amber-300/90 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <div className="truncate">
                调休补班：
                {next.makeUpWorkdays.map((w, idx) => (
                  <span key={w.date} className="font-medium text-amber-200 ml-1">
                    {w.date} ({w.name}){idx < (next.makeUpWorkdays?.length ?? 0) - 1 ? "、" : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-4 text-center text-xs text-zinc-500">
          今年暂无更多法定节假日或数据尚未收录
        </div>
      )}

      {/* Year Holiday List (Collapsible) */}
      {year?.periods && year.periods.length > 0 && (
        <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-3 flex flex-col gap-2">
          <button
            onClick={() => setShowAllHolidays(!showAllHolidays)}
            className="flex items-center justify-between text-xs font-medium text-zinc-300 hover:text-white transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <CalendarDays className="w-3.5 h-3.5 text-purple-400" />
              <span>{year.year} 年法定节假日总览 ({year.periods.length} 个)</span>
            </div>
            {showAllHolidays ? (
              <ChevronUp className="w-4 h-4 text-zinc-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-zinc-400" />
            )}
          </button>

          {showAllHolidays && (
            <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {year.periods.map((p) => {
                const isPassed = new Date(p.endDate).getTime() < new Date().setHours(0, 0, 0, 0);
                return (
                  <div
                    key={p.startDate}
                    className={cn(
                      "flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-xs transition-colors",
                      isPassed
                        ? "bg-zinc-950/20 border-zinc-800/40 text-zinc-400"
                        : "bg-zinc-900/60 border-zinc-800/80 text-zinc-300"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn("font-medium", !isPassed && "text-purple-300")}>
                        {p.name}
                      </span>
                      <span className="text-[11px] text-zinc-400">
                        {p.startDate.slice(5)} ~ {p.endDate.slice(5)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                        {p.days}天
                      </span>
                      {isPassed && (
                        <span className="text-[10px] text-zinc-400">已过</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
