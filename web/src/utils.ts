import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import * as lunarPkg from "lunar-javascript";

const Solar = (lunarPkg as any).Solar || (lunarPkg as any).default?.Solar || (lunarPkg as any).default;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(cents?: number | null): string {
  if (typeof cents !== "number" || isNaN(cents)) return "¥0.00";
  const yuan = cents / 100;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(yuan);
}

export function formatYuan(cents?: number | null): string {
  if (typeof cents !== "number" || isNaN(cents)) return "0.00";
  const yuan = cents / 100;
  return yuan.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function getLunarDateString(date: Date = new Date()): string {
  try {
    if (!Solar || typeof Solar.fromDate !== "function") return "";
    const solar = Solar.fromDate(date);
    const lunar = solar.getLunar();
    const ganZhi = lunar.getYearInGanZhi();
    const month = lunar.getMonthInChinese();
    const day = lunar.getDayInChinese();
    return `${ganZhi}年 ${month}月${day}`;
  } catch {
    return "";
  }
}

export function formatTime(isoString?: string | null): string {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return isoString;
  }
}

export function formatDateTime(isoString?: string | null): string {
  if (!isoString) return "";
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return isoString;
  }
}

export function getRelativeTimeLabel(dateStr?: string | null, timeStr?: string | null): { label: string; urgent: boolean } {
  if (!dateStr) return { label: timeStr || "未定", urgent: false };
  try {
    const cleanDate = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
    const target = new Date(`${cleanDate}T${timeStr || "00:00"}:00`);
    if (isNaN(target.getTime())) {
      return { label: timeStr || cleanDate, urgent: false };
    }
    const now = new Date();

    const targetDateOnly = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
    const nowDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const diffDays = Math.round((targetDateOnly - nowDateOnly) / (1000 * 60 * 60 * 24));

    if (isNaN(diffDays)) return { label: timeStr || cleanDate, urgent: false };
    if (diffDays < 0) return { label: `逾期 ${Math.abs(diffDays)} 天`, urgent: true };
    if (diffDays === 0) return { label: `今天 ${timeStr || ""}`.trim(), urgent: true };
    if (diffDays === 1) return { label: `明天 ${timeStr || ""}`.trim(), urgent: false };
    if (diffDays === 2) return { label: `后天 ${timeStr || ""}`.trim(), urgent: false };
    if (diffDays <= 7) return { label: `${diffDays} 天后`, urgent: false };
    return { label: `${target.getMonth() + 1}/${target.getDate()} ${timeStr || ""}`.trim(), urgent: false };
  } catch {
    return { label: timeStr || dateStr, urgent: false };
  }
}
