import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("scheduler due reminders cross the unified notification publisher", () => {
  const schedulerSource = fs.readFileSync(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  assert.match(schedulerSource, /import \{ publishNotification \} from "\.\/core\/notification-publisher\.js";/);
  assert.match(schedulerSource, /await publishNotification\(notification, \{ publishProfile \}\);/);
  assert.doesNotMatch(schedulerSource, /await publishProfile\(/);
});
