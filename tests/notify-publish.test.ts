import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// §6c：空 route 配置下 publishGlobal 的 fan-out 0 行分支（src/core/notify-publish.ts:101 循环 0 次）。
// 独立文件 + 独立 DATA_DIR：启动时不配置 PROFILE_PUSH_ROUTES_JSON，config.profilePushRoutes 为空对象，
// 不污染其他测试文件的环境。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "life-assistant-notify-publish-"));
process.env.DATA_DIR = dataDir;
process.env.HERMES_PROFILE = "profile-a";
delete process.env.PROFILE_PUSH_ROUTES_JSON;

const { config } = await import("../src/config.js");
const { getDatabase } = await import("../src/core/database.js");
const { publishGlobal } = await import("../src/core/notify-publish.js");
const db = getDatabase();

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("publishGlobal with zero configured routes fan-outs zero rows and creates no deliveries", async () => {
  assert.equal(Object.keys(config.profilePushRoutes).length, 0, "测试前置：必须无任何配置 route");

  await publishGlobal({
    title: "无人接收的全局通知",
    body: "空 route 时不应落库，也不应生成投递",
    dedupeKey: "publish:empty-routes:1",
  });

  const notifications = db.prepare("SELECT COUNT(*) AS n FROM profile_notifications").get() as { n: number };
  assert.equal(notifications.n, 0, "profile_notifications 不得有任何行");

  const deliveries = db.prepare("SELECT COUNT(*) AS n FROM profile_notification_deliveries").get() as { n: number };
  assert.equal(deliveries.n, 0, "不得生成任何 delivery");

  const retained = db.prepare("SELECT COUNT(*) AS n FROM global_notifications").get() as { n: number };
  assert.equal(retained.n, 0, "global_notifications 不受 publishGlobal 影响");
});

test("publishGlobal legacy-dedupe suppression path also stays inert with zero routes", async () => {
  // 即便 legacyDedupeKeys 命中也不得写入任何 Profile 行（fan-out 0 行分支先行返回）。
  await publishGlobal(
    { title: "旧键", body: "不应落库", dedupeKey: "publish:empty-routes:2" },
    { legacyDedupeKeys: ["publish:empty-routes:2"] },
  );
  const notifications = db.prepare("SELECT COUNT(*) AS n FROM profile_notifications").get() as { n: number };
  assert.equal(notifications.n, 0);
});