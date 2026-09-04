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

interface RequestOptions {
  profile?: string;
  params?: Record<string, string | number | boolean | undefined | null>;
  retries?: number;
  delayMs?: number;
}

export async function fetchApi<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { profile, params = {}, retries = 2, delayMs = 600 } = options;

  const url = new URL(path, window.location.origin);
  if (profile) {
    url.searchParams.set("profile", profile);
  }
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      const res = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as T;
      return data;
    } catch (err) {
      lastError = err;
      attempt++;
      if (attempt <= retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(1.5, attempt - 1)));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchOverview(profile?: string): Promise<OverviewData> {
  return fetchApi<OverviewData>("/api/overview", { profile });
}

export async function fetchWeather(profile?: string): Promise<WeatherData> {
  return fetchApi<WeatherData>("/api/weather", { profile });
}

export async function fetchOilPrice(profile?: string): Promise<OilPriceData> {
  return fetchApi<OilPriceData>("/api/oilprice", { profile });
}

export async function fetchHoliday(profile?: string): Promise<HolidayData> {
  return fetchApi<HolidayData>("/api/holiday", { profile });
}

export async function fetchSchedules(
  profile?: string,
  filters?: { status?: string; type?: string }
): Promise<ScheduleData> {
  return fetchApi<ScheduleData>("/api/schedules", {
    profile,
    params: {
      status: filters?.status,
      type: filters?.type,
    },
  });
}

export async function fetchBookkeeping(
  profile?: string,
  month?: string
): Promise<BookkeepingData> {
  return fetchApi<BookkeepingData>("/api/bookkeeping", {
    profile,
    params: { month },
  });
}

export async function fetchAutomations(
  profile?: string,
  enabled?: boolean
): Promise<AutomationsData> {
  return fetchApi<AutomationsData>("/api/automations", {
    profile,
    params: { enabled: enabled !== undefined ? String(enabled) : undefined },
  });
}

export async function fetchHealth(profile?: string): Promise<HealthData> {
  return fetchApi<HealthData>("/api/health", { profile });
}
