import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe, it } from "node:test";

// 防污染规则：在任何业务模块 import 前先创建临时目录并设置 process.env.DATA_DIR
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-server-test-"));
process.env.DATA_DIR = testDataDir;
process.env.HERMES_PROFILE = "test-profile";
process.env.LIFE_ASSISTANT_TIMEZONE = "Asia/Shanghai";

const { createApp } = await import("../src/server/app.js");
const app = createApp();

after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe("Backend Read-only REST API Server", () => {
  it("GET /api/health -> 200 and status ok", async () => {
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.status, "ok");
    assert.equal(typeof body.timestamp, "string");
    assert.equal(body.profile, "test-profile");
  });

  it("GET /api/health?profile=custom -> uses query profile", async () => {
    const res = await app.request("/api/health?profile=custom-profile");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.profile, "custom-profile");
  });

  it("GET /api/overview -> 200 and contains required fields", async () => {
    const res = await app.request("/api/overview");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.profile, "test-profile");
    assert.ok("calendar" in body);
    assert.ok("today" in body.calendar);
    assert.ok("nextHoliday" in body.calendar);
    assert.ok("schedules" in body);
    assert.equal(typeof body.schedules.activeCount, "number");
    assert.ok("bookkeeping" in body);
    assert.ok("summary" in body.bookkeeping);
    assert.ok("quietHours" in body);
    assert.ok("location" in body);
    assert.ok("weather" in body);
    assert.ok("oilprice" in body);
  });

  it("GET /api/holiday -> 200 and contains today, next, year", async () => {
    const res = await app.request("/api/holiday");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok("today" in body);
    assert.ok("next" in body);
    assert.ok("year" in body);
  });

  it("GET /api/schedules -> 200 and contains items array", async () => {
    const res = await app.request("/api/schedules");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.profile, "test-profile");
    assert.ok(Array.isArray(body.items));
    assert.equal(body.total, body.items.length);
  });

  it("GET /api/schedules with filters -> 200", async () => {
    const res = await app.request("/api/schedules?status=active&type=todo");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.items));
  });

  it("GET /api/bookkeeping -> 200 and contains accounts, summary, entries, ledgers", async () => {
    const res = await app.request("/api/bookkeeping");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.profile, "test-profile");
    assert.ok(Array.isArray(body.accounts));
    assert.ok(body.summary && typeof body.summary === "object");
    assert.ok(Array.isArray(body.entries));
    assert.ok(Array.isArray(body.ledgers));
  });

  it("GET /api/automations -> 200 and contains items array", async () => {
    const res = await app.request("/api/automations");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.profile, "test-profile");
    assert.ok(Array.isArray(body.items));
    assert.equal(body.total, body.items.length);
  });

  it("GET /api/automations?enabled=true -> 200", async () => {
    const res = await app.request("/api/automations?enabled=true");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.items));
  });

  it("GET /api/weather -> 200 (handles null location or returns weather)", async () => {
    const res = await app.request("/api/weather");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    if (body.error) {
      assert.equal(body.error, "location_not_set");
      assert.equal(body.location, null);
    } else {
      assert.ok("location" in body);
      assert.ok("current" in body);
      assert.ok("forecast" in body);
      assert.ok("airQuality" in body);
      assert.ok("alerts" in body);
      assert.ok("indices" in body);
    }
  });

  it("GET /api/oilprice -> 200 (contains location, current, nextAdjustment)", async () => {
    const res = await app.request("/api/oilprice");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok("location" in body);
    assert.ok("current" in body);
    assert.ok("nextAdjustment" in body);
  });

  it("createApp with profile option", async () => {
    const appWithOptions = createApp({ profile: "configured-profile" });
    const res = await appWithOptions.request("/api/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.profile, "configured-profile");
  });
});
