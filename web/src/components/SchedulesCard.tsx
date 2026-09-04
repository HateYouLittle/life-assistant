import React, { useState } from "react";
import {
  Bell,
  Calendar,
  CheckCircle2,
  Clock,
  Heart,
  ListTodo,
  PartyPopper,
  Repeat,
  Sparkles,
} from "lucide-react";
import type { ScheduleData, ScheduleItem, ScheduleType } from "../types";
import { cn, getRelativeTimeLabel } from "../utils";

interface SchedulesCardProps {
  data: ScheduleData | null;
  loading?: boolean;
}

type FilterTab = "all" | "todo" | "birthday" | "anniversary" | "completed";

export const SchedulesCard: React.FC<SchedulesCardProps> = ({ data, loading }) => {
  const [activeTab, setActiveTab] = useState<FilterTab>("all");

  if (loading && !data) {
    return (
      <div className="col-span-1 md:col-span-2 lg:col-span-2 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 animate-pulse flex flex-col gap-4 shadow-lg min-h-[300px]">
        <div className="h-6 w-32 bg-zinc-800 rounded-md" />
        <div className="h-8 bg-zinc-800/60 rounded-xl" />
        <div className="space-y-2">
          <div className="h-16 bg-zinc-800/40 rounded-xl" />
          <div className="h-16 bg-zinc-800/40 rounded-xl" />
        </div>
      </div>
    );
  }

  const items = data?.items || [];

  const filteredItems = items.filter((item) => {
    if (activeTab === "completed") return item.status === "completed";
    if (activeTab === "all") return item.status !== "completed";
    return item.type === activeTab && item.status !== "completed";
  });

  const getScheduleIcon = (type: ScheduleType, status: string) => {
    if (status === "completed") return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    switch (type) {
      case "birthday":
        return <PartyPopper className="w-4 h-4 text-pink-400" />;
      case "anniversary":
        return <Heart className="w-4 h-4 text-rose-400" />;
      case "todo":
      default:
        return <ListTodo className="w-4 h-4 text-sky-400" />;
    }
  };

  const getFrequencyLabel = (freq: string) => {
    switch (freq) {
      case "daily":
        return "每天";
      case "weekly":
        return "每周";
      case "monthly":
        return "每月";
      case "yearly":
        return "每年";
      case "workday":
        return "工作日";
      case "holiday":
        return "节假日";
      default:
        return null;
    }
  };

  const tabs: Array<{ id: FilterTab; label: string }> = [
    { id: "all", label: "全部待办" },
    { id: "todo", label: "待办" },
    { id: "birthday", label: "生日" },
    { id: "anniversary", label: "纪念日" },
    { id: "completed", label: "已完成" },
  ];

  return (
    <div className="col-span-1 md:col-span-2 lg:col-span-2 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 hover:border-zinc-700/80 transition-all shadow-lg flex flex-col justify-between gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400">
            <ListTodo className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white tracking-tight">
                日程与提醒
              </h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-sky-300 font-medium border border-zinc-700/50">
                {items.filter((i) => i.status === "active").length} 项活跃
              </span>
            </div>
            <p className="text-xs text-zinc-400">待办、纪念日与智能强提醒</p>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-3 py-1 rounded-xl text-xs font-medium transition-all shrink-0 border",
              activeTab === tab.id
                ? "bg-zinc-800 text-white border-zinc-700 shadow-sm"
                : "bg-zinc-950/40 text-zinc-400 border-zinc-800/80 hover:text-zinc-300 hover:bg-zinc-900"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Schedule Items List */}
      <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
        {filteredItems.length === 0 ? (
          <div className="py-10 text-center text-xs text-zinc-400 bg-zinc-950/20 rounded-xl border border-dashed border-zinc-800/60">
            暂无此分类日程事项
          </div>
        ) : (
          filteredItems.map((item) => {
            const timeInfo = getRelativeTimeLabel(item.date || item.nextOccurrenceSolar, item.time);
            const freqLabel = item.recurrence?.frequency ? getFrequencyLabel(item.recurrence.frequency) : null;
            const isCompleted = item.status === "completed";

            return (
              <div
                key={item.id}
                className={cn(
                  "p-3 rounded-xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3",
                  isCompleted
                    ? "bg-zinc-950/20 border-zinc-800/40 opacity-60"
                    : "bg-zinc-950/60 border-zinc-800/80 hover:border-zinc-700/80"
                )}
              >
                <div className="flex items-start gap-2.5 overflow-hidden">
                  <div className="mt-0.5 shrink-0">
                    {getScheduleIcon(item.type, item.status)}
                  </div>
                  <div className="overflow-hidden">
                    <h3
                      className={cn(
                        "text-xs font-semibold text-zinc-200 tracking-tight truncate",
                        isCompleted && "line-through text-zinc-400"
                      )}
                    >
                      {item.title}
                    </h3>
                    {item.note && (
                      <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-1">
                        {item.note}
                      </p>
                    )}
                  </div>
                </div>

                {/* Badges & Relative Time */}
                <div className="flex flex-wrap items-center gap-1.5 shrink-0 text-[10px]">
                  {/* Calendar type */}
                  {item.calendar === "lunar" && (
                    <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20">
                      农历
                    </span>
                  )}

                  {/* Recurrence */}
                  {freqLabel && (
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 flex items-center gap-1">
                      <Repeat className="w-2.5 h-2.5 text-zinc-400" />
                      {freqLabel}
                    </span>
                  )}

                  {/* Strong Reminder */}
                  {item.reminderIntervalMinutes !== undefined && item.reminderIntervalMinutes > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20 flex items-center gap-1">
                      <Bell className="w-2.5 h-2.5 text-rose-400" />
                      强提醒 {item.reminderIntervalMinutes}m×{item.reminderMaxAttempts || 3}
                    </span>
                  )}

                  {/* Priority */}
                  {item.priority === "high" && (
                    <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 font-bold border border-rose-500/30">
                      高优先
                    </span>
                  )}

                  {/* Relative Time Tag */}
                  <span
                    className={cn(
                      "px-2 py-0.5 rounded-full font-medium border ml-1",
                      timeInfo.urgent && !isCompleted
                        ? "bg-amber-500/15 text-amber-300 border-amber-500/30 font-semibold animate-pulse"
                        : "bg-zinc-800/60 text-zinc-400 border-zinc-700/50"
                    )}
                  >
                    {timeInfo.label}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
