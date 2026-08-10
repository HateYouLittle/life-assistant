import assert from "node:assert/strict";
import test from "node:test";

import crypto from "node:crypto";
import {
  parseProfilePushRoutes,
  resolveRenderTarget,
  type ProfilePushRoute,
} from "../src/config.js";

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
