import assert from "node:assert/strict";
import test from "node:test";

type ConfigEnvironmentVariable = "DAILY_WEATHER_BRIEF_CRON" | "LIFE_ASSISTANT_TIMEZONE";

let importSequence = 0;

async function loadConfigWith(name: ConfigEnvironmentVariable, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    const { config } = await import(`../src/config.js?config-test=${importSequence++}`);
    return config;
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("blank daily weather brief cron falls back to the default schedule", async () => {
  for (const value of ["", " \t "]) {
    const config = await loadConfigWith("DAILY_WEATHER_BRIEF_CRON", value);
    assert.equal(config.cron.dailyWeatherBrief, "0 7 * * *");
  }
});

test("daily weather brief cron is trimmed before use", async () => {
  const config = await loadConfigWith("DAILY_WEATHER_BRIEF_CRON", "  15 6 * * *\t");
  assert.equal(config.cron.dailyWeatherBrief, "15 6 * * *");
});

test("blank life assistant timezone falls back to the process local timezone", async () => {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const value of ["", " \t "]) {
    const config = await loadConfigWith("LIFE_ASSISTANT_TIMEZONE", value);
    assert.equal(config.timezone, localTimezone);
  }
});

test("life assistant timezone is trimmed before use", async () => {
  const config = await loadConfigWith("LIFE_ASSISTANT_TIMEZONE", "  Asia/Shanghai\t");
  assert.equal(config.timezone, "Asia/Shanghai");
});
