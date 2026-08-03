import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { fetchForecast } from "../src/modules/weather/provider.js";

test("QWeather forecast maps daily precip as millimeter amount", async (t) => {
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
