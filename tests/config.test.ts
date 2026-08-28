import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import crypto from "node:crypto";
import {
  parseProfilePushRoutes,
  resolveRenderTarget,
  type ProfilePushRoute,
} from "../src/config.js";

type ConfigEnvironmentVariable =
  | "DAILY_WEATHER_BRIEF_CRON"
  | "LIFE_ASSISTANT_TIMEZONE"
  | "HOLIDAY_REFRESH_CRON"
  | "DATA_DIR";

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

test("blank holiday refresh cron falls back to the default schedule", async () => {
  for (const value of ["", " \t "]) {
    const config = await loadConfigWith("HOLIDAY_REFRESH_CRON", value);
    assert.equal(config.cron.holidayRefresh, "0 2 * * *");
  }
});

test("holiday refresh cron is trimmed before use", async () => {
  const config = await loadConfigWith("HOLIDAY_REFRESH_CRON", "  30 3 * * *\t");
  assert.equal(config.cron.holidayRefresh, "30 3 * * *");
});

test("blank DATA_DIR falls back to the ./data directory", async () => {
  for (const value of ["", " \t "]) {
    const config = await loadConfigWith("DATA_DIR", value);
    assert.equal(config.dataDir, path.resolve("./data"));
  }
});

test("M8: an invalid IANA timezone fails configuration loading", async () => {
  for (const value of ["Not/AZone", "Mars/Olympus", "Asia/Shanghai/Extra"]) {
    await assert.rejects(
      () => loadConfigWith("LIFE_ASSISTANT_TIMEZONE", value),
      /LIFE_ASSISTANT_TIMEZONE.*is not a valid IANA timezone/,
    );
  }
});

test("M8: a relative DATA_DIR fails configuration loading", async () => {
  await assert.rejects(
    () => loadConfigWith("DATA_DIR", "relative/data"),
    /DATA_DIR.*must be an absolute path/,
  );
  await assert.rejects(
    () => loadConfigWith("DATA_DIR", "./data"),
    /DATA_DIR.*must be an absolute path/,
  );
});

test("L6: a valid paired LOCATION_LAT/LON is accepted as parsed numbers", async () => {
  const previousLat = process.env.LOCATION_LAT;
  const previousLon = process.env.LOCATION_LON;
  process.env.LOCATION_LAT = "39.9";
  process.env.LOCATION_LON = "116.4";
  try {
    const { config } = await import(`../src/config.js?config-test=${importSequence++}`);
    assert.equal(config.location.lat, 39.9);
    assert.equal(config.location.lon, 116.4);
    assert.equal(config.location.city, "");
  } finally {
    if (previousLat === undefined) delete process.env.LOCATION_LAT;
    else process.env.LOCATION_LAT = previousLat;
    if (previousLon === undefined) delete process.env.LOCATION_LON;
    else process.env.LOCATION_LON = previousLon;
  }
});

test("L6: non-numeric, out-of-range or unpaired coordinates warn and fall back to unset", async () => {
  const previousLat = process.env.LOCATION_LAT;
  const previousLon = process.env.LOCATION_LON;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = ((message: string) => {
    warnings.push(message);
  }) as typeof console.warn;
  const loadLocation = async (lat: string | undefined, lon: string | undefined) => {
    if (lat === undefined) delete process.env.LOCATION_LAT;
    else process.env.LOCATION_LAT = lat;
    if (lon === undefined) delete process.env.LOCATION_LON;
    else process.env.LOCATION_LON = lon;
    const { config } = await import(`../src/config.js?config-test=${importSequence++}`);
    return config.location;
  };
  try {
    // 非数字串 → NaN → 非法 → 未配置，并告警
    let location = await loadLocation("not-a-number", "116.4");
    assert.equal(location.lat, undefined);
    assert.equal(location.lon, undefined);
    assert.ok(warnings.some((line) => line.includes("LOCATION_LAT")), `expected LOCATION_LAT warning: ${warnings.join(" | ")}`);
    assert.ok(warnings.some((line) => line.includes("pair")), `expected pair warning: ${warnings.join(" | ")}`);

    // 越界纬度 → 未配置
    location = await loadLocation("91.5", "116.4");
    assert.equal(location.lat, undefined);
    assert.equal(location.lon, undefined);

    // 非法经度 → 未配置
    location = await loadLocation("39.9", "abc");
    assert.equal(location.lat, undefined);
    assert.equal(location.lon, undefined);

    // 只给纬度、不给经度 → 未配置 + 成对告警
    location = await loadLocation("39.9", undefined);
    assert.equal(location.lat, undefined);
    assert.equal(location.lon, undefined);
    assert.ok(warnings.some((line) => line.includes("pair")));

    // 留空串等价未设置
    location = await loadLocation("", "");
    assert.equal(location.lat, undefined);
    assert.equal(location.lon, undefined);
  } finally {
    if (previousLat === undefined) delete process.env.LOCATION_LAT;
    else process.env.LOCATION_LAT = previousLat;
    if (previousLon === undefined) delete process.env.LOCATION_LON;
    else process.env.LOCATION_LON = previousLon;
    console.warn = originalWarn;
  }
});

test("non-empty but invalid PROFILE_PUSH_ROUTES_JSON warns once without secrets", async () => {
  const previous = process.env.PROFILE_PUSH_ROUTES_JSON;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = ((message: string) => {
    warnings.push(message);
  }) as typeof console.warn;
  process.env.PROFILE_PUSH_ROUTES_JSON = JSON.stringify({
    bad: { route: "bad route", url: "http://127.0.0.1:8899/x", secret: "short" },
  });
  try {
    await import(`../src/config.js?config-test=${importSequence++}`);
  } finally {
    if (previous === undefined) delete process.env.PROFILE_PUSH_ROUTES_JSON;
    else process.env.PROFILE_PUSH_ROUTES_JSON = previous;
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], "PROFILE_PUSH_ROUTES_JSON is set but produced no valid routes");
  assert.ok(!warnings[0].includes("short"), "warning must not contain the route secret");
});

// ============================================================================
// 阶段 C：renderTarget 配置解析（C1 红 → C2 绿）
//   - parseProfilePushRoutes 接受合法 renderTarget（4 个值）
//   - 非法/未知值 → 条目保留但 renderTarget 缺省（运行时按 plain 处理）
//   - 老 JSON 缺省 → renderTarget 为 undefined
//   - 现有校验（64-hex secret、loopback URL、route 命名）不受新增字段影响
// ============================================================================

const strongSecret = (seed: string): string =>
  crypto.createHash("sha256").update(seed).digest("hex");

const validRoute = (seed: string, overrides: Partial<ProfilePushRoute> = {}): ProfilePushRoute => ({
  route: "qqbot",
  url: `http://127.0.0.1:${8700 + strongSecret(seed).charCodeAt(0) % 1000}/webhooks/${seed}`,
  secret: strongSecret(seed),
  ...overrides,
});

test("parseProfilePushRoutes accepts every valid renderTarget value", () => {
  const routes = parseProfilePushRoutes(JSON.stringify({
    "plain-a": { ...validRoute("plain-a"), renderTarget: "plain" },
    "qq-a": { ...validRoute("qq-a"), renderTarget: "qq-markdown" },
    "feishu-a": { ...validRoute("feishu-a"), renderTarget: "feishu-markdown" },
    "wechat-a": { ...validRoute("wechat-a"), renderTarget: "wechat-markdown" },
  }));
  assert.deepEqual(Object.keys(routes).sort(), ["feishu-a", "plain-a", "qq-a", "wechat-a"]);
  assert.equal(routes["plain-a"].renderTarget, "plain");
  assert.equal(routes["qq-a"].renderTarget, "qq-markdown");
  assert.equal(routes["feishu-a"].renderTarget, "feishu-markdown");
  assert.equal(routes["wechat-a"].renderTarget, "wechat-markdown");
});

test("parseProfilePushRoutes keeps entries with unknown renderTarget values but omits the field", () => {
  const routes = parseProfilePushRoutes(JSON.stringify({
    "kakaotalk-a": { ...validRoute("kakaotalk-a"), renderTarget: "kakaotalk" as never },
    "numeric-a": { ...validRoute("numeric-a"), renderTarget: 42 as never },
  }));
  assert.deepEqual(Object.keys(routes).sort(), ["kakaotalk-a", "numeric-a"]);
  assert.equal(routes["kakaotalk-a"].renderTarget, undefined);
  assert.equal(routes["numeric-a"].renderTarget, undefined);
});

test("parseProfilePushRoutes leaves renderTarget undefined for legacy JSON without the field", () => {
  const routes = parseProfilePushRoutes(JSON.stringify({
    "legacy-a": validRoute("legacy-a"),
  }));
  assert.deepEqual(Object.keys(routes), ["legacy-a"]);
  assert.equal(routes["legacy-a"].renderTarget, undefined);
  assert.equal(routes["legacy-a"].route, "qqbot");
});

test("existing route validation is unaffected by renderTarget", () => {
  const routes = parseProfilePushRoutes(JSON.stringify({
    good: { ...validRoute("good"), renderTarget: "qq-markdown" },
    weakSecret: { route: "qqbot", url: "http://127.0.0.1:8899/webhooks/weak", secret: "short", renderTarget: "qq-markdown" },
    external: { route: "qqbot", url: "https://example.com/webhooks/ext", secret: strongSecret("external"), renderTarget: "qq-markdown" },
    badRoute: { route: "bad route", url: "http://127.0.0.1:8899/webhooks/bad", secret: strongSecret("bad-route"), renderTarget: "qq-markdown" },
  }));
  assert.deepEqual(Object.keys(routes), ["good"]);
  assert.equal(routes.good.renderTarget, "qq-markdown");
});

test("resolveRenderTarget defaults missing or unknown targets to plain", () => {
  assert.equal(resolveRenderTarget(undefined), "plain");
  assert.equal(resolveRenderTarget(validRoute("unknown", { renderTarget: "kakaotalk" as never })), "plain");
  assert.equal(resolveRenderTarget(validRoute("plain", { renderTarget: "plain" })), "plain");
  assert.equal(resolveRenderTarget(validRoute("qq", { renderTarget: "qq-markdown" })), "qq-markdown");
  assert.equal(resolveRenderTarget(validRoute("feishu", { renderTarget: "feishu-markdown" })), "feishu-markdown");
  assert.equal(resolveRenderTarget(validRoute("wechat", { renderTarget: "wechat-markdown" })), "wechat-markdown");
});
