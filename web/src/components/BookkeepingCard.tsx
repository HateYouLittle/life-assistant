import React from "react";
import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowRightLeft,
  ArrowUpRight,
  Banknote,
  Briefcase,
  Car,
  Coffee,
  CreditCard,
  PieChart,
  ShoppingBag,
  Smartphone,
  Utensils,
  Wallet,
} from "lucide-react";
import type { BookkeepingData, EntryType } from "../types";
import { cn, formatDateTime, formatYuan } from "../utils";

interface BookkeepingCardProps {
  data: BookkeepingData | null;
  loading?: boolean;
}

export const BookkeepingCard: React.FC<BookkeepingCardProps> = ({
  data,
  loading,
}) => {
  if (loading && !data) {
    return (
      <div className="col-span-1 md:col-span-2 lg:col-span-2 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 animate-pulse flex flex-col gap-4 shadow-lg min-h-[300px]">
        <div className="h-6 w-32 bg-zinc-800 rounded-md" />
        <div className="grid grid-cols-3 gap-3">
          <div className="h-20 bg-zinc-800/60 rounded-xl" />
          <div className="h-20 bg-zinc-800/60 rounded-xl" />
          <div className="h-20 bg-zinc-800/60 rounded-xl" />
        </div>
        <div className="h-28 bg-zinc-800/40 rounded-xl" />
      </div>
    );
  }

  const { summary, accounts = [], entries = [] } = data || {};
  const activeAccounts = accounts.filter((a) => !a.archived);

  // Helper for entry category icon
  const getCategoryIcon = (category: string = "", type: EntryType) => {
    if (type === "transfer") return <ArrowRightLeft className="w-4 h-4 text-sky-400" />;
    if (/餐饮|外卖|餐|饭|吃/.test(category)) return <Utensils className="w-4 h-4 text-amber-400" />;
    if (/咖啡|茶|奶茶|饮品/.test(category)) return <Coffee className="w-4 h-4 text-amber-300" />;
    if (/购物|超市|日用|买/.test(category)) return <ShoppingBag className="w-4 h-4 text-pink-400" />;
    if (/交通|打车|公交|地铁|油/.test(category)) return <Car className="w-4 h-4 text-blue-400" />;
    if (/工资|兼职|收益|奖金/.test(category)) return <Briefcase className="w-4 h-4 text-emerald-400" />;
    if (type === "income") return <ArrowDownLeft className="w-4 h-4 text-emerald-400" />;
    return <Banknote className="w-4 h-4 text-zinc-400" />;
  };

  const getAccountIcon = (type: string) => {
    switch (type) {
      case "bank":
        return <CreditCard className="w-4 h-4 text-blue-400" />;
      case "alipay":
        return <Smartphone className="w-4 h-4 text-sky-400" />;
      case "wechat":
        return <Smartphone className="w-4 h-4 text-emerald-400" />;
      case "cash":
        return <Wallet className="w-4 h-4 text-amber-400" />;
      default:
        return <CreditCard className="w-4 h-4 text-zinc-400" />;
    }
  };

  const isNetPositive = (summary?.netCents ?? 0) >= 0;

  return (
    <div className="col-span-1 md:col-span-2 lg:col-span-2 bg-zinc-900/60 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 hover:border-zinc-700/80 transition-all shadow-lg flex flex-col justify-between gap-5">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <Wallet className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-white tracking-tight">
                财务记账
              </h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 font-medium border border-zinc-700/50">
                {summary?.month || "本月"}
              </span>
            </div>
            <p className="text-xs text-zinc-400">个人与共享账本汇总</p>
          </div>
        </div>

        {summary && (
          <div className="text-right text-xs text-zinc-400">
            本月记账 <span className="text-white font-mono font-bold">{summary.entryCount}</span> 笔
          </div>
        )}
      </div>

      {/* 3 Summary Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Income */}
        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>当月收入</span>
            <div className="p-1 rounded-md bg-emerald-500/10 text-emerald-400">
              <ArrowDownLeft className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="text-xs text-emerald-400 font-semibold">+¥</span>
            <span className="text-2xl font-bold tracking-tight text-emerald-400 font-mono">
              {formatYuan(summary?.incomeCents ?? 0)}
            </span>
          </div>
          <span className="text-[11px] text-zinc-400">工资 / 兼职 / 其他收入</span>
        </div>

        {/* Expense */}
        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>当月支出</span>
            <div className="p-1 rounded-md bg-rose-500/10 text-rose-400">
              <ArrowUpRight className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="text-xs text-rose-400 font-semibold">-¥</span>
            <span className="text-2xl font-bold tracking-tight text-rose-400 font-mono">
              {formatYuan(summary?.expenseCents ?? 0)}
            </span>
          </div>
          <span className="text-[11px] text-zinc-400">日常开销 / 消费账单</span>
        </div>

        {/* Net Balance */}
        <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>当月结余</span>
            <div className={cn("p-1 rounded-md", isNetPositive ? "bg-sky-500/10 text-sky-400" : "bg-rose-500/10 text-rose-400")}>
              <PieChart className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className={cn("text-xs font-semibold", isNetPositive ? "text-sky-400" : "text-rose-400")}>
              {isNetPositive ? "+¥" : "-¥"}
            </span>
            <span
              className={cn(
                "text-2xl font-bold tracking-tight font-mono",
                isNetPositive ? "text-sky-400" : "text-rose-400"
              )}
            >
              {formatYuan(Math.abs(summary?.netCents ?? 0))}
            </span>
          </div>
          <span className="text-[11px] text-zinc-400">
            {isNetPositive ? "收支盈余结转" : "支出超出收入"}
          </span>
        </div>
      </div>

      {/* Accounts & Balances */}
      {activeAccounts.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-zinc-400">账户资产分布</span>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
            {activeAccounts.map((acc) => (
              <div
                key={acc.id}
                className="bg-zinc-950/40 border border-zinc-800/60 hover:border-zinc-700/60 rounded-xl p-2.5 flex items-center justify-between gap-2 transition-all"
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <div className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800">
                    {getAccountIcon(acc.type)}
                  </div>
                  <div className="overflow-hidden">
                    <p className="text-xs font-medium text-zinc-300 truncate">{acc.name}</p>
                    <span className="text-[10px] text-zinc-400">
                      {acc.kind === "shared" ? "共享" : "个人"}
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-xs font-bold text-white font-mono">
                    ¥{formatYuan(acc.balanceCents)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Transactions List */}
      <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800/60">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-400">最近流水清单</span>
          <span className="text-[11px] text-zinc-400">最新 {Math.min(entries.length, 6)} 笔</span>
        </div>

        {entries.length === 0 ? (
          <div className="py-6 text-center text-xs text-zinc-400 bg-zinc-950/20 rounded-xl border border-dashed border-zinc-800/60">
            暂无记账流水记录
          </div>
        ) : (
          <div className="space-y-2">
            {entries.slice(0, 6).map((entry) => {
              const isExpense = entry.type === "expense";
              const isIncome = entry.type === "income";
              return (
                <div
                  key={entry.id}
                  className="bg-zinc-950/40 border border-zinc-800/60 hover:border-zinc-700/60 rounded-xl px-3 py-2 flex items-center justify-between gap-3 transition-colors text-xs"
                >
                  <div className="flex items-center gap-2.5 overflow-hidden">
                    <div className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 shrink-0">
                      {getCategoryIcon(entry.category, entry.type)}
                    </div>
                    <div className="overflow-hidden">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-zinc-200 truncate">
                          {entry.category || (entry.type === "transfer" ? "内部转账" : "日常收支")}
                        </span>
                        {entry.note && (
                          <span className="text-[11px] text-zinc-400 truncate max-w-[140px]">
                            · {entry.note}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-zinc-400">
                        {formatDateTime(entry.occurredAt)}
                      </span>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span
                      className={cn(
                        "font-bold font-mono text-sm",
                        isIncome && "text-emerald-400",
                        isExpense && "text-rose-400",
                        entry.type === "transfer" && "text-sky-400"
                      )}
                    >
                      {isIncome ? "+" : isExpense ? "-" : ""}
                      ¥{formatYuan(entry.amountCents)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
