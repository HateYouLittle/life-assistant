import React, { useEffect, useState } from "react";
import {
  CalendarDays,
  Clock,
  Moon,
  RotateCw,
  Sparkles,
  User,
} from "lucide-react";
import type { DayInfo, QuietHours } from "../types";
import { cn, getLunarDateString } from "../utils";

interface HeaderProps {
  profile: string;
  onProfileChange: (profile: string) => void;
  dayInfo: DayInfo | null;
  quietHours: QuietHours | null;
  onRefresh: () => void;
  loading: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  profile,
  onProfileChange,
  dayInfo,
  quietHours,
  onRefresh,
  loading,
}) => {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const timeString = time.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const weekDayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const dateString = `${time.getFullYear()}年${time.getMonth() + 1}月${time.getDate()}日 ${weekDayNames[time.getDay()]}`;
  const lunarString = getLunarDateString(time);

  // Determine if currently in quiet hours
  const isInQuiet = React.useMemo(() => {
    if (!quietHours) return false;
    const currentMinutes = time.getHours() * 60 + time.getMinutes();
    const [sH, sM] = quietHours.start.split(":").map(Number);
    const [eH, eM] = quietHours.end.split(":").map(Number);
    const startMinutes = sH * 60 + sM;
    const endMinutes = eH * 60 + eM;

    if (startMinutes < endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    // Overnight quiet window, e.g. 22:00 to 07:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }, [quietHours, time]);

  return (
    <header className="w-full bg-zinc-900/70 backdrop-blur-xl border-b border-zinc-800/80 sticky top-0 z-30 px-4 lg:px-8 py-3.5 transition-colors">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Brand & Profile */}
        <div className="flex items-center justify-between w-full md:w-auto gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 p-0.5 shadow-lg shadow-emerald-500/20">
              <div className="w-full h-full bg-zinc-950 rounded-[10px] flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-emerald-400 animate-pulse" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">
                  Life Assistant
                </h1>
                <span className="text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  Dashboard
                </span>
              </div>
              <p className="text-xs text-zinc-400 hidden sm:block">
                智能生活助手控制台
              </p>
            </div>
          </div>

          {/* Profile Switcher */}
          <div className="flex items-center gap-2 bg-zinc-950/80 border border-zinc-800 px-3 py-1.5 rounded-xl shadow-inner">
            <User className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-xs text-zinc-400">Profile:</span>
            <select
              value={profile}
              onChange={(e) => onProfileChange(e.target.value)}
              className="bg-transparent text-xs font-medium text-emerald-400 focus:outline-none cursor-pointer pr-1"
            >
              <option value="default" className="bg-zinc-900 text-zinc-200">
                默认 (default)
              </option>
              <option value="bestie" className="bg-zinc-900 text-zinc-200">
                闺蜜 (bestie)
              </option>
            </select>
          </div>
        </div>

        {/* Center / Right: Time, Lunar, Badges & Actions */}
        <div className="flex flex-wrap items-center justify-center md:justify-end gap-3 w-full md:w-auto">
          {/* Calendar & Lunar Badge */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-950/60 border border-zinc-800/80 text-xs text-zinc-300">
            <CalendarDays className="w-3.5 h-3.5 text-zinc-400" />
            <span>{dateString}</span>
            {lunarString && (
              <span className="text-zinc-500 pl-1 border-l border-zinc-800">
                {lunarString}
              </span>
            )}
          </div>

          {/* Clock */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-950/80 border border-zinc-800/80 text-xs text-white font-mono font-bold tracking-wider shadow-inner">
            <Clock className="w-3.5 h-3.5 text-emerald-400" />
            <span>{timeString}</span>
          </div>

          {/* Day Type Badge */}
          {dayInfo && (
            <div
              className={cn(
                "px-2.5 py-1 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-all",
                dayInfo.isHoliday
                  ? "bg-purple-500/15 text-purple-300 border-purple-500/30"
                  : dayInfo.dayType === "workday"
                    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                    : dayInfo.isWorkday
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      : "bg-sky-500/15 text-sky-300 border-sky-500/30"
              )}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-ping" />
              <span>
                {dayInfo.isHoliday
                  ? dayInfo.name || "法定节假日"
                  : dayInfo.dayType === "workday"
                    ? "调休补班"
                    : dayInfo.isWorkday
                      ? "工作日"
                      : "周末休假"}
              </span>
            </div>
          )}

          {/* Quiet Hours Indicator */}
          {quietHours ? (
            <div
              className={cn(
                "px-2.5 py-1 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-all",
                isInQuiet
                  ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40 shadow-sm shadow-indigo-500/10"
                  : "bg-zinc-800/60 text-zinc-400 border-zinc-700/60"
              )}
              title={
                isInQuiet
                  ? `勿扰中 (${quietHours.start} - ${quietHours.end})`
                  : `勿扰预定 (${quietHours.start} - ${quietHours.end})`
              }
            >
              <Moon className={cn("w-3.5 h-3.5", isInQuiet && "text-indigo-400 fill-indigo-400/20")} />
              <span>
                {isInQuiet
                  ? `勿扰中 (${quietHours.start}-${quietHours.end})`
                  : `勿扰 ${quietHours.start}-${quietHours.end}`}
              </span>
            </div>
          ) : (
            <div className="px-2.5 py-1 rounded-xl text-xs text-zinc-500 bg-zinc-900 border border-zinc-800 flex items-center gap-1.5">
              <Moon className="w-3.5 h-3.5 text-zinc-600" />
              <span>勿扰关</span>
            </div>
          )}

          {/* Refresh Button */}
          <button
            onClick={onRefresh}
            disabled={loading}
            title="刷新数据"
            className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 hover:bg-zinc-800 active:scale-95 transition-all disabled:opacity-50"
          >
            <RotateCw className={cn("w-4 h-4", loading && "animate-spin text-emerald-400")} />
          </button>
        </div>
      </div>
    </header>
  );
};
