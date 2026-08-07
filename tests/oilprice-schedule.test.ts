import assert from "node:assert/strict";
import test from "node:test";

import { ADJUSTMENT_WINDOWS_2026, nextWindow } from "../src/modules/oilprice/schedule.js";

test("2026 adjustment windows match the published 25 window dates", () => {
  assert.deepEqual(ADJUSTMENT_WINDOWS_2026, [
    "2026-01-06", "2026-01-20", "2026-02-03", "2026-02-24", "2026-03-09",
    "2026-03-23", "2026-04-07", "2026-04-21", "2026-05-08", "2026-05-21",
    "2026-06-04", "2026-06-18", "2026-07-03", "2026-07-17", "2026-07-31",
    "2026-08-14", "2026-08-28", "2026-09-11", "2026-09-24", "2026-10-15",
    "2026-10-29", "2026-11-12", "2026-11-26", "2026-12-10", "2026-12-24",
  ]);
});

test("nextWindow uses the Shanghai business date and an explicit next-midnight effective instant", () => {
  const window = nextWindow(new Date("2026-08-07T01:00:00.000Z"));

  assert.deepEqual(window, {
    date: "2026-08-14",
    effectiveAt: "2026-08-15T00:00:00+08:00",
    hoursUntil: 183,
  });
});

test("the current window remains active immediately before its 24:00 boundary", () => {
  const window = nextWindow(new Date("2026-08-14T15:59:59.999Z"));

  assert.equal(window?.date, "2026-08-14");
  assert.equal(window?.effectiveAt, "2026-08-15T00:00:00+08:00");
});

test("nextWindow advances at the exact Shanghai 24:00 boundary", () => {
  const window = nextWindow(new Date("2026-08-14T16:00:00.000Z"));

  assert.equal(window?.date, "2026-08-28");
  assert.equal(window?.effectiveAt, "2026-08-29T00:00:00+08:00");
});
