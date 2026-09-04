import React from "react";
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle,
  Clock,
  Cpu,
  Power,
  RefreshCw,
  Workflow,
  Zap,
} from "lucide-react";
import type { AutomationItem, AutomationsData, HealthData } from "../types";
import { cn, formatDateTime } from "../utils";

interface AutomationsCardProps {
  data: AutomationsData | null;
  health: HealthData | null;
  loading?: boolean;
}

export const AutomationsCard: React.FC<AutomationsCardProps> = ({
  data,
  health,
  loading,
}) => {
  if (loading && !data) {
    return (
      <div className="col-span-1 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 animate-pulse flex flex-col gap-4 shadow-lg min-h-[300px]">
        <div className="h-6 w-32 bg-zinc-800 rounded-md" />
        <div className="h-16 bg-zinc-800/60 rounded-xl" />
        <div className="space-y-2">
          <div className="h-20 bg-zinc-800/40 rounded-xl" />
          <div className="h-20 bg-zinc-800/40 rounded-xl" />
        </div>
      </div>
    );
  }

  const items = data?.items || [];
  const activeCount = items.filter((i) => i.enabled).length;

  const formatSchedule = (schedule: AutomationItem["schedule"]) => {
    if (schedule.type === "daily") {
      return `每天 ${schedule.time}`;
    }
    return `每 ${schedule.minutes} 分钟`;
  };

  return (
    <div className="col-span-1 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 hover:border-zinc-700/80 transition-all shadow-lg flex flex-col justify-between gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-400">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white tracking-tight">
                自动化与系统
              </h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-teal-300 font-medium border border-zinc-700/50">
                {activeCount} 活跃规则
              </span>
            </div>
            <p className="text-xs text-zinc-400">后台规则引擎与任务流</p>
          </div>
        </div>
      </div>

      {/* System Health Status Banner */}
      <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 absolute inset-0 animate-ping opacity-75" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-white flex items-center gap-1">
              后端服务运行正常
            </span>
            <span className="text-[10px] text-zinc-400">
              心跳时间: {health ? formatDateTime(health.timestamp) : "刚刚"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-medium">
          <Cpu className="w-3 h-3" />
          <span>PORT {typeof window !== "undefined" && window.location.port ? window.location.port : "3080"}</span>
        </div>
      </div>

      {/* Automation Rules List */}
      <div className="space-y-2.5 max-h-[320px] overflow-y-auto pr-1">
        {items.length === 0 ? (
          <div className="py-8 text-center text-xs text-zinc-400 bg-zinc-950/20 rounded-xl border border-dashed border-zinc-800/60">
            暂无配置自动化规则任务
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className={cn(
                "p-3 rounded-xl border transition-all flex flex-col gap-2",
                item.enabled
                  ? "bg-zinc-950/50 border-zinc-800/80 hover:border-zinc-700/80"
                  : "bg-zinc-950/20 border-zinc-800/40 opacity-60"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 overflow-hidden">
                  <div
                    className={cn(
                      "p-1.5 rounded-lg border",
                      item.enabled
                        ? "bg-teal-500/10 border-teal-500/20 text-teal-400"
                        : "bg-zinc-900 border-zinc-800 text-zinc-400"
                    )}
                  >
                    <Workflow className="w-3.5 h-3.5" />
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-200 tracking-tight">
                      {item.name}
                    </h3>
                    <p className="text-[10px] text-zinc-400 font-mono mt-0.5">
                      {item.action}
                    </p>
                  </div>
                </div>

                {/* Status Dot & Schedule Badge */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300 font-medium">
                    {formatSchedule(item.schedule)}
                  </span>
                  <div
                    className={cn(
                      "w-2 h-2 rounded-full",
                      item.enabled ? "bg-emerald-500" : "bg-zinc-600"
                    )}
                    title={item.enabled ? "规则已启用" : "规则已禁用"}
                  />
                </div>
              </div>

              {/* Conditions & Last Run */}
              <div className="flex items-center justify-between pt-1.5 border-t border-zinc-900 text-[10px] text-zinc-400">
                {item.condition ? (
                  <span className="truncate max-w-[150px] font-mono text-zinc-300">
                    条件: {item.condition.field} {item.condition.op} {item.condition.value}
                  </span>
                ) : (
                  <span className="text-zinc-400">无前置判断触发</span>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  {item.lastError ? (
                    <span className="text-rose-400 flex items-center gap-0.5">
                      <AlertCircle className="w-2.5 h-2.5" /> 运行失败
                    </span>
                  ) : item.lastRunAt ? (
                    <span className="text-emerald-400 flex items-center gap-0.5">
                      <CheckCircle className="w-2.5 h-2.5" /> 最近运行: {formatDateTime(item.lastRunAt)}
                    </span>
                  ) : (
                    <span className="text-zinc-400">待执行</span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
