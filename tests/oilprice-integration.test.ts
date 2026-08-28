import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { TianApiOilPrice } from "../src/modules/oilprice/provider.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-oilprice-test-"));
const secretA = crypto.createHash("sha256").update("oilprice profile a fixture").digest("hex");
const secretB = crypto.createHash("sha256").update("oilprice profile b fixture").digest("hex");
process.env.DATA_DIR = dataDir;
process.env.PROFILE_PUSH_ROUTES_JSON = JSON.stringify({
  "oil-profile-a": { route: "qqbot", url: "http://127.0.0.1:18644/webhooks/test", secret: secretA },
  "oil-profile-b": { route: "qqbot", url: "http://127.0.0.1:18645/webhooks/test", secret: secretB },
});

const { getDatabase } = await import("../src/core/database.js");
const { pullPending } = await import("../src/core/notifier.js");
const {
  observeOilPrice,
  oilPriceStateRepository,
  runOilPriceWatch,
} = await import("../src/modules/oilprice/watch.js");
const db = getDatabase();

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function observation(province: string, next = false): TianApiOilPrice {
  return {
    adjustmentEvidence: true,
    province,
    unit: "元/升",
    provider: "TianAPI",
    source: "TianAPI 成品油市场数据",
    providerEffectiveDate: next ? "2026-08-15" : "2026-08-01",
    windowDate: next ? "2026-08-14" : "2026-07-31",
    nextWindowDate: next ? "2026-08-28" : "2026-08-14",
    fuels: next ? {
      p92: { current: "8.03", previous: "7.93", change: "0.10" },
      p95: { current: "8.46", previous: "8.51", change: "-0.05" },
      p0: { current: "7.69", previous: "7.69", change: "0.00" },
    } : {
      p92: { current: "7.93", previous: "7.38", change: "0.55" },
      p95: { current: "8.51", previous: "7.92", change: "0.59" },
      p0: { current: "7.69", previous: "7.12", change: "0.57" },
    },
  };
}

test("advance notices materialize once per window across Profile fan-out and remain pull-isolated", async () => {
  for (let run = 0; run < 2; run += 1) {
    await runOilPriceWatch({
      at: new Date("2026-08-13T01:00:00.000Z"),
      getLocation: () => ({ city: "萍乡市安源区" }),
      fetchPrice: async () => observation("江西"),
    });
  }

  const noticeRows = db.prepare(
    "SELECT profile_id, dedupe_key FROM profile_notifications WHERE source = 'oilprice' ORDER BY profile_id",
  ).all() as Array<{ profile_id: string; dedupe_key: string }>;
  const notices = noticeRows.map(({ profile_id, dedupe_key }) => ({ profile_id, dedupe_key }));
  // 第二轮观测是同窗完整证据：按新行为发布正式结果（identity 含 windowDate 防重），
  // advance 仍由 dedupe 保证每窗口只落库一次
  assert.deepEqual(notices, [
    { profile_id: "oil-profile-a", dedupe_key: "oilprice:advance:2026-08-14" },
    { profile_id: "oil-profile-a", dedupe_key: "oilprice:result:江西:2026-07-31" },
    { profile_id: "oil-profile-b", dedupe_key: "oilprice:advance:2026-08-14" },
    { profile_id: "oil-profile-b", dedupe_key: "oilprice:result:江西:2026-07-31" },
  ]);
  assert.equal(Number((db.prepare(
    "SELECT count(*) AS count FROM profile_notification_deliveries WHERE status = 'pending'",
  ).get() as { count: number }).count), 4);

  assert.deepEqual(pullPending("oil-profile-a").map((notice) => notice.dedupeKey), [
    "oilprice:advance:2026-08-14",
    "oilprice:result:江西:2026-07-31",
  ]);
  assert.deepEqual(pullPending("oil-profile-b").map((notice) => notice.dedupeKey), [
    "oilprice:advance:2026-08-14",
    "oilprice:result:江西:2026-07-31",
  ]);
  assert.deepEqual(pullPending("oil-profile-a"), []);
});

test("publisher dedupe prevents a duplicate result when state advancement fails and then retries", async () => {
  const province = "重试省";
  await observeOilPrice(observation(province), {
    observedAt: new Date("2026-08-07T01:00:00.000Z"),
  });
  let failOnce = true;
  const flakyRepository = {
    get: oilPriceStateRepository.get,
    set(state: Parameters<typeof oilPriceStateRepository.set>[0]) {
      if (state.lastProcessedWindow && failOnce) {
        failOnce = false;
        throw new Error("fixture state write failure");
      }
      oilPriceStateRepository.set(state);
    },
  };

  await assert.rejects(observeOilPrice(observation(province, true), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"),
    repository: flakyRepository,
  }), /fixture state write failure/);
  // 时序钉住：发布先于状态写——通知已落库（profile fan-out 2 行）而 lastProcessedWindow 仍未写
  assert.equal(Number((db.prepare(
    "SELECT count(*) AS count FROM profile_notifications WHERE dedupe_key = ?",
  ).get(`oilprice:result:${province}:2026-08-14`) as { count: number }).count), 2);
  assert.equal(oilPriceStateRepository.get(province)?.lastProcessedWindow, undefined);

  assert.equal(await observeOilPrice(observation(province, true), {
    observedAt: new Date("2026-08-15T01:05:00.000Z"),
  }), "published");
  assert.equal(oilPriceStateRepository.get(province)?.lastProcessedWindow, "2026-08-14");
  assert.equal(Number((db.prepare(
    "SELECT count(*) AS count FROM profile_notifications WHERE dedupe_key = ?",
  ).get(`oilprice:result:${province}:2026-08-14`) as { count: number }).count), 2);
});
