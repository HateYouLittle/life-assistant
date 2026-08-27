import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("scheduler stays a pure orchestrator: schedule knowledge lives in the module", () => {
  const schedulerSource = fs.readFileSync(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  // 核心 scheduler 只经注册表驱动模块 tick，绝不 import 任何 modules/* 内部文件。
  assert.match(schedulerSource, /import \{ getModules \} from "\.\/modules\/index\.js";/);
  assert.doesNotMatch(schedulerSource, /from "\.\/modules\/(?!index)/);
  // 到期扫描统一经由模块 tick 扩展点，投递管道仍由 scheduler 收口。
  assert.match(schedulerSource, /await module\.tick\(at\);/);
  assert.match(schedulerSource, /deliverPendingProfileNotifications\(\{ at, fetchImpl \}\);/);

  const registrySource = fs.readFileSync(new URL("../src/core/registry.ts", import.meta.url), "utf8");
  const moduleIndex = fs.readFileSync(new URL("../src/modules/index.ts", import.meta.url), "utf8");
  const tickModule = fs.readFileSync(new URL("../src/modules/schedule/tick.ts", import.meta.url), "utf8");

  // tick 是 registry 声明的模块扩展点；schedule 模块经由它接入每分钟扫描。
  assert.match(registrySource, /tick\?: \(at: Date\) => Promise<void>;/);
  assert.match(moduleIndex, /import "\.\/schedule\/index\.js";/);
  // 模块内扫描沿用统一发布桥（内部默认走 publishProfile fan-out）。
  assert.match(tickModule, /publishNotification/);
});
