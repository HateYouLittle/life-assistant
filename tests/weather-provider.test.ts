import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { config } from "../src/config.js";
import { httpJson, redactUrl } from "../src/core/http.js";
import { WMO, fetchAlerts, fetchCurrent, fetchForecast } from "../src/modules/weather/provider.js";

test("QWeather forecast maps daily precip as millimeter amount", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /\/v7\/weather\/3d\?/);
    // 和风 v7 location 参数为 "经度,纬度"（lon,lat）
    assert.match(String(input), /location=116\.40,39\.90/);
    return Response.json({
      daily: [{
        fxDate: "2026-08-03",
        tempMax: "31",
        tempMin: "24",
        textDay: "中雨",
        iconDay: "306",
        precip: "12.7",
      }],
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await fetchForecast(39.9, 116.4, 1), [{
    date: "2026-08-03",
    tMax: 31,
    tMin: 24,
    weatherText: "中雨",
    precipAmountMm: 12.7,
  }]);
});

test("QWeather current passes lon,lat order and maps now fields", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /\/v7\/weather\/now\?location=116\.40,39\.90/);
    return Response.json({
      now: { temp: "31", feelsLike: "33", humidity: "60", windSpeed: "12", text: "多云", icon: "101" },
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await fetchCurrent(39.9, 116.4), {
    temperature: 31,
    apparent: 33,
    humidity: 60,
    windSpeed: 12,
    windSpeedUnit: "km/h",
    weatherText: "多云",
  });
});

test("QWeather forecast drops zero precip amount instead of emitting 0mm", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /\/v7\/weather\/3d\?/);
    return Response.json({
      daily: [{
        fxDate: "2026-08-03",
        tempMax: "31",
        tempMin: "24",
        textDay: "晴",
        iconDay: "100",
        precip: "0",
      }],
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await fetchForecast(39.9, 116.4, 1), [{
    date: "2026-08-03",
    tMax: 31,
    tMin: 24,
    weatherText: "晴",
    precipAmountMm: undefined,
  }]);
});

test("QWeather forecast business error code falls back to Open-Meteo", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/v7/weather/3d")) return Response.json({ code: "401" });
    assert.match(url, /api\.open-meteo\.com/);
    return Response.json({
      daily: {
        time: ["2026-08-03"],
        temperature_2m_max: [30],
        temperature_2m_min: [23],
        weather_code: [80],
        precipitation_probability_max: [65],
      },
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await fetchForecast(39.9, 116.4, 1), [{
    date: "2026-08-03",
    tMax: 30,
    tMin: 23,
    weatherText: "阵雨",
    precipProb: 65,
  }]);
  assert.equal(calls, 2);
});

test("QWeather alerts business error code falls back to threshold inference", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/weatheralert/v1/current/")) return Response.json({ code: "403" });
    assert.match(url, /api\.open-meteo\.com/);
    return Response.json({
      hourly: {
        temperature_2m: [20, 21, 22],
        precipitation: [0, 0, 0],
        wind_speed_10m: [5, 6, 7],
      },
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  // 未达任何推断阈值 → 空数组；两次调用证明已降级
  assert.deepEqual(await fetchAlerts("北京", 39.9, 116.4), []);
  assert.equal(calls, 2);
});

test("redactUrl strips query parameters while keeping origin and pathname", () => {
  assert.equal(
    redactUrl("https://devapi.qweather.com/v7/weather/now?location=116.40,39.90&key=super-secret"),
    "https://devapi.qweather.com/v7/weather/now?(redacted)",
  );
  assert.equal(redactUrl("https://api.open-meteo.com/v1/forecast?latitude=39.9"), "https://api.open-meteo.com/v1/forecast?(redacted)");
  assert.equal(redactUrl("https://example.com/path"), "https://example.com/path");
  assert.equal(redactUrl("not-a-url"), "not-a-url");
});

test("httpJson HTTP error message never leaks the query string", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({}, { status: 500 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => httpJson("https://devapi.qweather.com/v7/weather/now?key=super-secret"),
    (err: Error) => {
      assert.equal(err.message, "HTTP 500 for https://devapi.qweather.com/v7/weather/now?(redacted)");
      assert.ok(!err.message.includes("super-secret"), "error message must not contain the API key");
      return true;
    },
  );
});

test("Open-Meteo forecast maps daily precipitation maximum as probability percent", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "";
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /precipitation_probability_max/);
    return Response.json({
      daily: {
        time: ["2026-08-03"],
        temperature_2m_max: [30],
        temperature_2m_min: [23],
        weather_code: [80],
        precipitation_probability_max: [65],
      },
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await fetchForecast(39.9, 116.4, 1), [{
    date: "2026-08-03",
    tMax: 30,
    tMin: 23,
    weatherText: "阵雨",
    precipProb: 65,
  }]);
});

test("QWeather official alerts preserve every reliable structured field and the complete description", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/qweather-alert-current.json", import.meta.url), "utf8"));
  config.qweatherKey = "test-key";
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /\/weatheralert\/v1\/current\/39\.90\/116\.40\?/);
    return Response.json(fixture);
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await fetchAlerts("北京", 39.9, 116.4), [{
    kind: "official",
    id: "202608041411009200029230",
    publisher: "江西省气象台",
    issuedAt: "2026-08-04T06:11Z",
    eventType: "雷电",
    eventCode: "1014",
    level: "橙色",
    severity: "severe",
    effectiveAt: "2026-08-04T06:11Z",
    onsetAt: "2026-08-04T06:11Z",
    expiresAt: "2026-08-04T11:11Z",
    headline: "江西省气象台2026年08月04日14时11分发布雷电橙色预警信号。",
    description: "江西省气象台2026年08月04日14时11分发布雷电橙色预警信号：预计未来2小时内，鹰潭、南昌、萍乡三市和上饶市南部及九江市北部、抚州市东部、吉安市西部的部分地区有强雷电活动，局地伴有短时强降水、雷雨大风等强对流天气，请注意防范。",
    criteria: "2小时内发生雷电活动的可能性很大，或者已经受雷电活动影响，且可能持续，出现雷电灾害事故的可能性比较大。",
    instruction: "1.政府及相关部门按照职责做好防雷工作；2.密切关注天气，尽量避免户外活动。",
    attributions: [
      "国家预警信息发布中心",
      "当前预警数据可能存在延迟或信息过时，以官方数据发布为准。",
    ],
  }]);
});

const WMO_COMMON_CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];

const WMO_PREVIOUSLY_MISSING: Record<number, string> = {
  53: "毛毛雨",
  55: "密集毛毛雨",
  56: "冻毛毛雨（轻微）",
  57: "冻毛毛雨（密集）",
  66: "冻雨（轻微）",
  67: "冻雨（密集）",
  77: "雪粒",
  85: "阵雪（轻微）",
  86: "阵雪（强烈）",
};

test("WMO mapping covers all common weather codes without raw code fallback", () => {
  for (const code of WMO_COMMON_CODES) {
    const label = WMO[code];
    assert.ok(label, `WMO[${code}] must have a Chinese label`);
    assert.doesNotMatch(label, /^code \d+$/, `WMO[${code}] must not fall back to "code N"`);
  }
  for (const [code, label] of Object.entries(WMO_PREVIOUSLY_MISSING)) {
    assert.equal(WMO[Number(code)], label);
  }
});

test("Open-Meteo forecast maps WMO weather code 55 to 密集毛毛雨", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "";
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /daily=weather_code/);
    return Response.json({
      daily: {
        time: ["2026-08-11"],
        temperature_2m_max: [28.6],
        temperature_2m_min: [25.3],
        weather_code: [55],
        precipitation_probability_max: [80],
      },
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  const [today] = await fetchForecast(27.62, 113.85, 1);
  assert.equal(today.weatherText, "密集毛毛雨");
});
