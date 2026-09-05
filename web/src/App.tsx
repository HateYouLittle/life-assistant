import React, { useCallback, useEffect, useRef, useState } from "react";
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

interface ProfileCache {
  overview?: OverviewData;
  schedules?: ScheduleData;
  bookkeeping?: BookkeepingData;
  automations?: AutomationsData;
}

export default function App() {
  const [profile, setProfile] = useState<string>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("profile") || localStorage.getItem("hermes_profile") || "default";
    } catch {
      return "default";
    }
  });

  // Global states (independent of profile)
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [oilPrice, setOilPrice] = useState<OilPriceData | null>(null);
  const [holiday, setHoliday] = useState<HolidayData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [globalLoading, setGlobalLoading] = useState<boolean>(true);

  // Profile-specific states
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [schedules, setSchedules] = useState<ScheduleData | null>(null);
  const [bookkeeping, setBookkeeping] = useState<BookkeepingData | null>(null);
  const [automations, setAutomations] = useState<AutomationsData | null>(null);
  const [profileLoading, setProfileLoading] = useState<boolean>(true);

  const [error, setError] = useState<string | null>(null);

  // In-memory cache for profile-scoped data (SWR)
  const profileCacheRef = useRef<Record<string, ProfileCache>>({});
  const currentProfileRef = useRef<string>(profile);
  currentProfileRef.current = profile;

  const handleProfileChange = (newProfile: string) => {
    if (newProfile === profile) return;
    setProfile(newProfile);
    currentProfileRef.current = newProfile;
    try {
      localStorage.setItem("hermes_profile", newProfile);
    } catch {}
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("profile", newProfile);
      window.history.replaceState({}, "", url.toString());
    } catch {}

    // SWR: 如果已有缓存，立即无缝呈现，0ms 响应
    const cached = profileCacheRef.current[newProfile];
    if (cached) {
      if (cached.overview) setOverview(cached.overview);
      if (cached.schedules) setSchedules(cached.schedules);
      if (cached.bookkeeping) setBookkeeping(cached.bookkeeping);
      if (cached.automations) setAutomations(cached.automations);
    } else {
      // 首次切入该 profile 时，清空旧 profile 的私有数据以防混淆
      setOverview(null);
      setSchedules(null);
      setBookkeeping(null);
      setAutomations(null);
    }
  };

  // 1. 加载全局独立数据（天气/油价/节假日/系统健康）
  const loadGlobalData = useCallback(async () => {
    setGlobalLoading(true);
    try {
      const [weatherRes, oilPriceRes, holidayRes, healthRes] = await Promise.allSettled([
        fetchWeather(),
        fetchOilPrice(),
        fetchHoliday(),
        fetchHealth(),
      ]);

      if (weatherRes.status === "fulfilled") setWeather(weatherRes.value);
      if (oilPriceRes.status === "fulfilled") setOilPrice(oilPriceRes.value);
      if (holidayRes.status === "fulfilled") setHoliday(holidayRes.value);
      if (healthRes.status === "fulfilled") setHealth(healthRes.value);
    } catch (err) {
      console.error("Failed to load global data:", err);
    } finally {
      setGlobalLoading(false);
    }
  }, []);

  // 2. 加载 Profile 专属数据（渐进流式更新，毫秒级快速接口优先上屏）
  const loadProfileData = useCallback(async (targetProfile: string) => {
    setProfileLoading(true);
    setError(null);

    const activeProfile = targetProfile;

    const fetchPromises = [
      fetchBookkeeping(activeProfile)
        .then((data) => {
          if (currentProfileRef.current === activeProfile) {
            setBookkeeping(data);
            profileCacheRef.current[activeProfile] = {
              ...profileCacheRef.current[activeProfile],
              bookkeeping: data,
            };
          }
          return { name: "bookkeeping", ok: true };
        })
        .catch((err) => ({ name: "bookkeeping", ok: false, error: err })),

      fetchSchedules(activeProfile)
        .then((data) => {
          if (currentProfileRef.current === activeProfile) {
            setSchedules(data);
            profileCacheRef.current[activeProfile] = {
              ...profileCacheRef.current[activeProfile],
              schedules: data,
            };
          }
          return { name: "schedules", ok: true };
        })
        .catch((err) => ({ name: "schedules", ok: false, error: err })),

      fetchAutomations(activeProfile)
        .then((data) => {
          if (currentProfileRef.current === activeProfile) {
            setAutomations(data);
            profileCacheRef.current[activeProfile] = {
              ...profileCacheRef.current[activeProfile],
              automations: data,
            };
          }
          return { name: "automations", ok: true };
        })
        .catch((err) => ({ name: "automations", ok: false, error: err })),

      fetchOverview(activeProfile)
        .then((data) => {
          if (currentProfileRef.current === activeProfile) {
            setOverview(data);
            profileCacheRef.current[activeProfile] = {
              ...profileCacheRef.current[activeProfile],
              overview: data,
            };
          }
          return { name: "overview", ok: true };
        })
        .catch((err) => ({ name: "overview", ok: false, error: err })),
    ];

    try {
      const results = await Promise.all(fetchPromises);
      const failureErrors = results
        .filter((r): r is { name: string; ok: false; error: unknown } => !r.ok)
        .map((r) => r.error);
      if (failureErrors.length > 0) {
        const isUnauthorized = failureErrors.some(
          (err) => String(err).includes("401") || String(err).includes("Unauthorized"),
        );
        if (isUnauthorized) {
          setError("API 鉴权失败（401 Unauthorized）：请在 URL 添加 ?token=<your_token> 或检查后台 WEB_API_TOKEN");
        } else if (failureErrors.length === 4) {
          setError("获取看板数据失败：当前 Profile 后端接口无法连接");
        }
      }
    } finally {
      if (currentProfileRef.current === activeProfile) {
        setProfileLoading(false);
      }
    }
  }, []);

  // 初次挂载加载全局数据
  useEffect(() => {
    loadGlobalData();
  }, [loadGlobalData]);

  // Profile 变更时只拉取该 Profile 数据
  useEffect(() => {
    loadProfileData(profile);
  }, [profile, loadProfileData]);

  // 全量手动刷新
  const handleFullRefresh = useCallback(() => {
    profileCacheRef.current = {};
    loadGlobalData();
    loadProfileData(profile);
  }, [loadGlobalData, loadProfileData, profile]);

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
        onRefresh={handleFullRefresh}
        loading={globalLoading || profileLoading}
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
              onClick={handleFullRefresh}
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
            loading={globalLoading}
            onRetry={loadGlobalData}
          />
          <OilPriceCard
            data={oilPrice}
            loading={globalLoading}
          />

          {/* Row 2: Bookkeeping (2 cols) & Holiday (1 col) */}
          <BookkeepingCard
            data={bookkeeping}
            loading={profileLoading}
          />
          <HolidayCard
            data={holiday}
            loading={globalLoading}
          />

          {/* Row 3: Schedules (2 cols) & Automations (1 col) */}
          <SchedulesCard
            data={schedules}
            loading={profileLoading}
          />
          <AutomationsCard
            data={automations}
            health={health}
            loading={profileLoading}
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
