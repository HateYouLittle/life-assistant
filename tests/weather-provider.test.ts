import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { config } from "../src/config.js";
import { httpJson, redactUrl } from "../src/core/http.js";
import { WMO, fetchAlerts, fetchCurrent, fetchForecast, fetchIndices } from "../src/modules/weather/provider.js";

test("QWeather forecast maps daily precip as precipitation amount in mm", async (t) => {
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

  // precip 是当日累计降水量（mm）（2026-08 实测专属 host 响应无 precipProb 字段）；
  // 按概率解释会把 12.7mm 中雨显示成"概率 12.7%"并漏掉带伞建议。
  assert.deepEqual(await fetchForecast(39.9, 116.4, 1), [{
    date: "2026-08-03",
    tMax: 31,
    tMin: 24,
    weatherText: "中雨",
    precipAmountMm: 12.7,
  }]);
});

test("QWeather short daily arrays fall back to Open-Meteo", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    if (String(input).includes("/v7/weather/3d")) return Response.json({ daily: [{ fxDate: "2026-08-03", tempMax: "31", tempMin: "24", textDay: "晴", iconDay: "100", precip: "0" }] });
    return Response.json({ daily: { time: ["2026-08-03", "2026-08-04", "2026-08-05"], temperature_2m_max: [30, 30, 30], temperature_2m_min: [20, 20, 20], weather_code: [0, 0, 0], precipitation_probability_max: [0, 0, 0] } });
  }) as typeof fetch;
  t.after(() => { config.qweatherKey = originalKey; globalThis.fetch = originalFetch; });
  const forecast = await fetchForecast(39.9, 116.4, 3);
  assert.equal(forecast.length, 3);
  assert.equal(calls, 2);
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

test("QWeather forecast with malformed precip falls back to Open-Meteo instead of treating it as no rain", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/v7/weather/3d")) {
      return Response.json({
        daily: [{
          fxDate: "2026-08-03",
          tempMax: "31",
          tempMin: "24",
          textDay: "中雨",
          iconDay: "306",
          precip: "abc",
        }],
      });
    }
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

  // 畸形 precip 与非法温度同口径（N12）：抛错走 Open-Meteo 兜底，而不是静默当「无降水」。
  assert.deepEqual(await fetchForecast(39.9, 116.4, 1), [{
    date: "2026-08-03",
    tMax: 30,
    tMin: 23,
    weatherText: "阵雨",
    precipProb: 65,
  }]);
  assert.equal(calls, 2);
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

test("Open-Meteo current response with missing fields throws instead of returning NaN", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "";
  globalThis.fetch = (async (input) => {
    assert.match(String(input), /api\.open-meteo\.com/);
    return Response.json({ current: { temperature_2m: 28, relative_humidity_2m: 60, apparent_temperature: 30, wind_speed_10m: 5 } });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => fetchCurrent(39.9, 116.4),
    /weather provider: current\.weather_code is missing or not a finite number/,
  );
});

test("QWeather forecast with empty daily falls back to Open-Meteo", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/v7/weather/3d")) return Response.json({ daily: [] });
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

test("QWeather current with NaN temperature falls back to Open-Meteo", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "test-key";
  let calls = 0;
  globalThis.fetch = (async (input) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/v7/weather/now")) {
      return Response.json({
        now: { temp: "NaN", feelsLike: "33", humidity: "60", windSpeed: "12", text: "多云", icon: "101" },
      });
    }
    assert.match(url, /api\.open-meteo\.com/);
    return Response.json({
      current: {
        temperature_2m: 28.5,
        relative_humidity_2m: 55,
        apparent_temperature: 29,
        weather_code: 2,
        wind_speed_10m: 8,
      },
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(await fetchCurrent(39.9, 116.4), {
    temperature: 28.5,
    apparent: 29,
    humidity: 55,
    windSpeed: 8,
    windSpeedUnit: "m/s",
    weatherText: "多云",
  });
  assert.equal(calls, 2);
});

test("redactUrl strips query parameters while keeping origin and pathname", () => {
  assert.equal(
    redactUrl("https://devapi.qweather.com/v7/weather/now?location=116.40,39.90&key=super-secret"),
    "https://devapi.qweather.com/v7/weather/now?(redacted)",
  );
  assert.equal(redactUrl("https://api.open-meteo.com/v1/forecast?latitude=39.9"), "https://api.open-meteo.com/v1/forecast?(redacted)");
  assert.equal(redactUrl("https://example.com/path"), "https://example.com/path");
  assert.equal(redactUrl("not-a-url"), "(invalid-url)");
  assert.equal(redactUrl("not a url?key=SECRET"), "(invalid-url)");
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

test("httpJson 4xx is not retried and the error message is redacted", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({}, { status: 400 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => httpJson("https://devapi.qweather.com/v7/weather/now?key=super-secret"),
    (err: Error) => {
      assert.equal(err.message, "HTTP 400 for https://devapi.qweather.com/v7/weather/now?(redacted)");
      assert.ok(!err.message.includes("super-secret"), "error message must not contain the API key");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("httpJson 5xx is retried exactly once", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({}, { status: 503 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => httpJson("https://example.com/api?token=super-secret"),
    (err: Error) => {
      assert.equal(err.message, "HTTP 503 for https://example.com/api?(redacted)");
      assert.ok(!err.message.includes("super-secret"), "error message must not contain the token");
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("httpJson does not retry a POST with a body on network error", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError("network down");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => httpJson("https://example.com/api", {
      method: "POST",
      body: JSON.stringify({ action: "archive" }),
    }),
    /network down/,
  );
  assert.equal(calls, 1);
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

test("Open-Meteo forecast tolerates null precipitation probability per day", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "";
  globalThis.fetch = (async () => {
    return Response.json({
      daily: {
        time: ["2026-08-03", "2026-08-04"],
        temperature_2m_max: [30, 31],
        temperature_2m_min: [23, 24],
        weather_code: [80, 80],
        // 集合预报未覆盖的地区逐日返回 null：按元素降级为 undefined，不拖垮整条预报。
        precipitation_probability_max: [null, 65],
      },
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  const days = await fetchForecast(39.9, 116.4, 2);
  assert.equal(days[0].precipProb, undefined);
  assert.equal(days[1].precipProb, 65);
});

test("Open-Meteo wind speed requests m/s in current and inferred-alert queries", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "";
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    if (String(input).includes("current=")) {
      return Response.json({
        current: { temperature_2m: 25, relative_humidity_2m: 60, apparent_temperature: 27, weather_code: 0, wind_speed_10m: 3.2 },
      });
    }
    return Response.json({
      hourly: { temperature_2m: [20], precipitation: [0], wind_speed_10m: [5] },
    });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  const current = await fetchCurrent(39.9, 116.4);
  assert.equal(current.windSpeedUnit, "m/s");
  assert.ok(urls[0].includes("windspeed_unit=ms"), "current 查询必须显式请求 m/s（默认 km/h）");

  const alerts = await fetchAlerts("北京", 39.9, 116.4);
  assert.deepEqual(alerts, []);
  assert.ok(urls[1].includes("windspeed_unit=ms"), "推断预警必须显式请求 m/s（17.2 阈值是 m/s 口径）");
});

test("Open-Meteo indices degrade to empty when uv_index_max is null", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "";
  globalThis.fetch = (async () => {
    return Response.json({ daily: { uv_index_max: [null] } });
  }) as typeof fetch;
  t.after(() => {
    config.qweatherKey = originalKey;
    globalThis.fetch = originalFetch;
  });

  const result = await fetchIndices("北京", 39.9, 116.4);
  assert.deepEqual(result.indices, []);
  assert.equal(result.degraded, true);
  assert.equal(result.source, "Open-Meteo");
});

test("L9: Open-Meteo forecast passes the brief-provided timezone explicitly instead of timezone=auto", async (t) => {
  const originalKey = config.qweatherKey;
  const originalFetch = globalThis.fetch;
  config.qweatherKey = "";
  let url = "";
  globalThis.fetch = (async (input) => {
    url = String(input);
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

  // 简报时区（Asia/Shanghai）作为显式查询参数：Open-Meteo 按简报同一时区切日，
  // 与 daily brief identity 的「今日」语义对齐；timezone=auto 会按坐标当地时区切日。
  await fetchForecast(39.9, 116.4, 2, "北京", "Asia/Shanghai");
  assert.ok(url.includes("timezone=Asia%2FShanghai"), `Open-Meteo 请求必须带简报时区，实际 URL: ${url}`);
  assert.ok(!url.includes("timezone=auto"), "不得退回 timezone=auto（与简报本地日错位）");

  // 未显式传时区时默认用 config.timezone（同样不是 auto）。
  await fetchForecast(39.9, 116.4, 1);
  assert.ok(!url.includes("timezone=auto"), "默认路径也必须显式时区");
});
