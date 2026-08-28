import assert from "node:assert/strict";
import test from "node:test";

import { DateTime } from "luxon";

import {
  ADJUSTMENT_WINDOWS_2026,
  ADJUSTMENT_WINDOWS_2027,
  candidateWindowDatesFrom,
  nearestWindowDeviationDays,
  nextWindow,
} from "../src/modules/oilprice/schedule.js";

const BUSINESS_TIMEZONE = "Asia/Shanghai";

test("2026 adjustment windows match the published 25 window dates", () => {
  assert.deepEqual(ADJUSTMENT_WINDOWS_2026, [
    "2026-01-06", "2026-01-20", "2026-02-03", "2026-02-24", "2026-03-09",
    "2026-03-23", "2026-04-07", "2026-04-21", "2026-05-08", "2026-05-21",
    "2026-06-04", "2026-06-18", "2026-07-03", "2026-07-17", "2026-07-31",
    "2026-08-14", "2026-08-28", "2026-09-11", "2026-09-24", "2026-10-15",
    "2026-10-29", "2026-11-12", "2026-11-26", "2026-12-10", "2026-12-24",
  ]);
});

test("2027 has no published official calendar yet; the candidate generator fills the gap", () => {
  // 截至本实现日期未查到官方 2027 调价日历（国务院节假日安排尚未公布）：
  // 静态表留空，nextWindow 在表耗尽后按"每 10 个工作日"规则生成候选窗口。
  assert.deepEqual(ADJUSTMENT_WINDOWS_2027, []);
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

test("static table windows do not carry the candidate calibration marker", () => {
  const window = nextWindow(new Date("2026-08-07T01:00:00.000Z"));

  assert.equal(window !== null, true);
  assert.equal("calibrated" in window, false);
  assert.equal(window?.calibrated, undefined);
});

test("nextWindow returns an uncalibrated candidate once the static table is exhausted", () => {
  // 纯"每 10 个工作日"规则下 2027-01-01（周五）也算工作日，故首个候选为 2027-01-07
  const window = nextWindow(new Date("2027-01-05T01:00:00.000Z"));

  assert.deepEqual(window, {
    date: "2027-01-07",
    effectiveAt: "2027-01-08T00:00:00+08:00",
    hoursUntil: 63,
    calibrated: false,
  });
});

test("candidate windows continue across the year with exactly 10 working days between windows", () => {
  const dates = candidateWindowDatesFrom("2026-12-24", 6);

  assert.deepEqual(dates, [
    "2027-01-07", "2027-01-21", "2027-02-04", "2027-02-18",
    "2027-03-04", "2027-03-18",
  ]);
  // 相邻候选恰好相隔 10 个工作日（周一至周五，含下一窗口日；两窗口日之间的工作日为 9）。
  // 规则不含法定节假日剔除，故为未校准候选。
  for (let i = 1; i < dates.length; i += 1) {
    let workdays = 0;
    let probe = DateTime.fromISO(dates[i - 1], { zone: BUSINESS_TIMEZONE }).plus({ days: 1 });
    while (probe.toISODate() !== dates[i]) {
      if (probe.weekday <= 5) workdays += 1;
      probe = probe.plus({ days: 1 });
    }
    assert.equal(workdays, 9, `workdays strictly between ${dates[i - 1]} and ${dates[i]}`);
  }
});

test("candidate windows participate in nearest-window deviation checks for off-table years", () => {
  // 2027 年起静态表覆盖不到，候选窗口参与偏差计算，避免 2027 年正常数据每日误告警
  assert.equal(nearestWindowDeviationDays("2027-01-07"), 0); // 候选窗口本身
  assert.equal(nearestWindowDeviationDays("2027-01-08"), 1); // 候选次日
  assert.equal(nearestWindowDeviationDays("2027-02-01"), 3); // 介于 2027-01-21 与 2027-02-04 之间
});