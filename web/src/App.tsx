import React, { useCallback, useEffect, useState } from "react";
import {
  fetchAutomations,
  fetchBookkeeping,
  fetchHealth,
  fetchHoliday,
  fetchOilPrice,
  fetchOverview,
  fetchSchedules,
  fetchWeather,
} from "./api";
import { AutomationsCard } from "./components/AutomationsCard";
import { BookkeepingCard } from "./components/BookkeepingCard";
import { Header } from "./components/Header";
import { HolidayCard } from "./components/HolidayCard";
import { OilPriceCard } from "./components/OilPriceCard";
import { SchedulesCard } from "./components/SchedulesCard";
import { WeatherCard } from "./components/WeatherCard";
import type {
  AutomationsData,
  BookkeepingData,
  HealthData,
  HolidayData,
  OilPriceData,
  OverviewData,
  ScheduleData,
  WeatherData,
} from "./types";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function App() {
  const [profile, setProfile] = useState<string>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("profile") || localStorage.getItem("hermes_profile") || "default";
    } catch {
      return "default";
    }
  });

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [oilPrice, setOilPrice] = useState<OilPriceData | null>(null);
  const [holiday, setHoliday] = useState<HolidayData | null>(null);
  const [schedules, setSchedules] = useState<ScheduleData | null>(null);
  const [bookkeeping, setBookkeeping] = useState<BookkeepingData | null>(null);
  const [automations, setAutomations] = useState<AutomationsData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const handleProfileChange = (newProfile: string) => {
    setProfile(newProfile);
    try {
      localStorage.setItem("hermes_profile", newProfile);
    } catch {}
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("profile", newProfile);
      window.history.replaceState({}, "", url.toString());
    } catch {}
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [
        overviewRes,
        weatherRes,
        oilPriceRes,
        holidayRes,
        schedulesRes,
        bookkeepingRes,
        automationsRes,
        healthRes,
      ] = await Promise.allSettled([
        fetchOverview(profile),
        fetchWeather(profile),
        fetchOilPrice(profile),
        fetchHoliday(profile),
        fetchSchedules(profile),
        fetchBookkeeping(profile),
        fetchAutomations(profile),
        fetchHealth(profile),
      ]);

      if (overviewRes.status === "fulfilled") setOverview(overviewRes.value);
      if (weatherRes.status === "fulfilled") setWeather(weatherRes.value);
      if (oilPriceRes.status === "fulfilled") setOilPrice(oilPriceRes.value);
      if (holidayRes.status === "fulfilled") setHoliday(holidayRes.value);
      if (schedulesRes.status === "fulfilled") setSchedules(schedulesRes.value);
      if (bookkeepingRes.status === "fulfilled") setBookkeeping(bookkeepingRes.value);
      if (automationsRes.status === "fulfilled") setAutomations(automationsRes.value);
      if (healthRes.status === "fulfilled") setHealth(healthRes.value);

      const failures = [
        overviewRes,
        weatherRes,
        oilPriceRes,
        holidayRes,
        schedulesRes,
        bookkeepingRes,
        automationsRes,
        healthRes,
      ].filter((r) => r.status === "rejected");

      if (failures.length > 0 && !overviewRes) {
        setError("部分数据接口加载失败，已展示已获取内容");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取看板数据失败");
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Derived today dayInfo from holiday or overview
  const dayInfo = holiday?.today || overview?.calendar?.today || null;
  const quietHours = overview?.quietHours || null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-emerald-500/20 selection:text-emerald-400">
      {/* Global Header */}
      <Header
        profile={profile}
        onProfileChange={handleProfileChange}
        dayInfo={dayInfo}
        quietHours={quietHours}
        onRefresh={loadData}
        loading={loading}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        {/* Error Banner */}
        {error && (
          <div className="bg-rose-950/40 border border-rose-500/40 rounded-2xl p-4 flex items-center justify-between text-xs text-rose-300 shadow-lg">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{error}</span>
            </div>
            <button
              onClick={loadData}
              className="px-3 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 transition-colors flex items-center gap-1.5 font-medium"
            >
              <RefreshCw className="w-3 h-3" /> 重试
            </button>
          </div>
        )}

        {/* Bento Grid Layout */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {/* Row 1: Weather (2 cols) & Oil Price (1 col) */}
          <WeatherCard
            data={weather}
            loading={loading}
            onRetry={loadData}
          />
          <OilPriceCard
            data={oilPrice}
            loading={loading}
          />

          {/* Row 2: Bookkeeping (2 cols) & Holiday (1 col) */}
          <BookkeepingCard
            data={bookkeeping}
            loading={loading}
          />
          <HolidayCard
            data={holiday}
            loading={loading}
          />

          {/* Row 3: Schedules (2 cols) & Automations (1 col) */}
          <SchedulesCard
            data={schedules}
            loading={loading}
          />
          <AutomationsCard
            data={automations}
            health={health}
            loading={loading}
          />
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-zinc-900 py-4 text-center text-xs text-zinc-400">
        <p>Life Assistant Dashboard · Powered by Hermes Agent & Hono</p>
      </footer>
    </div>
  );
}
