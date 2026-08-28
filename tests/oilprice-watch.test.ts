import assert from "node:assert/strict";
import test from "node:test";

import type { OilPriceObservation, TianApiOilPrice } from "../src/modules/oilprice/provider.js";
import {
  observeOilPrice,
  runOilPriceWatch,
  type OilPriceState,
  type OilPriceStateRepository,
} from "../src/modules/oilprice/watch.js";

function tianObservation(overrides: Partial<TianApiOilPrice> = {}): TianApiOilPrice {
  return {
    adjustmentEvidence: true,
    province: "江西",
    unit: "元/升",
    provider: "TianAPI",
    source: "TianAPI 成品油市场数据",
    providerEffectiveDate: "2026-08-01",
    windowDate: "2026-07-31",
    nextWindowDate: "2026-08-14",
    fuels: {
      p92: { current: "7.93", previous: "7.38", change: "0.55" },
      p95: { current: "8.51", previous: "7.92", change: "0.59" },
      p0: { current: "7.69", previous: "7.12", change: "0.57" },
    },
    ...overrides,
  };
}

function nextObservation(overrides: Partial<TianApiOilPrice> = {}): TianApiOilPrice {
  return tianObservation({
    providerEffectiveDate: "2026-08-15",
    windowDate: "2026-08-14",
    nextWindowDate: "2026-08-28",
    fuels: {
      p92: { current: "8.03", previous: "7.93", change: "0.10" },
      p95: { current: "8.46", previous: "8.51", change: "-0.05" },
      p0: { current: "7.69", previous: "7.69", change: "0.00" },
    },
    ...overrides,
  });
}

function strandedObservation(overrides: Partial<TianApiOilPrice> = {}): TianApiOilPrice {
  return nextObservation({
    fuels: {
      p92: { current: "7.93", previous: "7.93", change: "0.00" },
      p95: { current: "8.51", previous: "8.51", change: "0.00" },
      p0: { current: "7.69", previous: "7.69", change: "0.00" },
    },
    ...overrides,
  });
}

function juheObservation(): OilPriceObservation {
  return {
    adjustmentEvidence: false,
    province: "江西",
    unit: "元/升",
    provider: "JUHE",
    source: "聚合数据当前油价",
    fuels: {
      p92: { current: "7.93" },
      p95: { current: "8.51" },
      p0: { current: "7.69" },
    },
  };
}

function memoryRepository(initial?: OilPriceState): OilPriceStateRepository & { value?: OilPriceState } {
  return {
    value: initial,
    get() { return this.value; },
    set(state) { this.value = structuredClone(state); },
  };
}

const baselineState: OilPriceState = {
  schemaVersion: 1,
  initialized: true,
  province: "江西",
  unit: "元/升",
  provider: "TianAPI",
  fuels: { p92: "7.93", p95: "8.51", p0: "7.69" },
  providerEffectiveDate: "2026-08-01",
  windowDate: "2026-07-31",
  observedAt: "2026-08-07T09:00:00+08:00",
};

test("the first complete TianAPI observation only establishes a baseline", async () => {
  const repository = memoryRepository();
  let publishes = 0;
  const outcome = await observeOilPrice(tianObservation(), {
    observedAt: new Date("2026-08-07T01:00:00.000Z"),
    repository,
    publish: async () => { publishes += 1; },
  });

  assert.equal(outcome, "baseline");
  assert.equal(publishes, 0);
  assert.deepEqual(repository.value, baselineState);
});

test("the first JUHE snapshot may establish a baseline but cannot publish a result", async () => {
  const repository = memoryRepository();
  let publishes = 0;
  assert.equal(await observeOilPrice(juheObservation(), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"), repository,
    publish: async () => { publishes += 1; },
  }), "baseline");
  assert.equal(publishes, 0);
  assert.equal(repository.value?.provider, "JUHE");
  assert.equal(repository.value?.windowDate, undefined);
});

test("a published window revision refreshes the baseline so the next window can publish", async () => {
  const repository = memoryRepository(baselineState);
  const calls: Array<{ source: string; title: string; body: string; dedupeKey: string }> = [];
  const outcome = await observeOilPrice(nextObservation(), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"), repository,
    publish: async ({ source, title, body, dedupeKey }) => { calls.push({ source, title, body, dedupeKey }); },
  });

  assert.equal(outcome, "published");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dedupeKey, "oilprice:result:江西:2026-08-14");
  assert.match(calls[0].body, /92号汽油：8\.03元\/升，每升上涨0\.10元/);
  assert.equal(repository.value?.lastProcessedWindow, "2026-08-14");
  assert.deepEqual(repository.value?.fuels, { p92: "8.03", p95: "8.46", p0: "7.69" });

  const revised = nextObservation({
    fuels: {
      p92: { current: "8.04", previous: "7.93", change: "0.11" },
      p95: { current: "8.46", previous: "8.51", change: "-0.05" },
      p0: { current: "7.69", previous: "7.69", change: "0.00" },
    },
  });
  // 同窗完整证据修订：发布（identity 与首次发布相同，生产侧 dedupe 防重不会双发），并回写修订基线
  assert.equal(await observeOilPrice(revised, {
    observedAt: new Date("2026-08-15T02:00:00.000Z"), repository,
    publish: async ({ source, title, body, dedupeKey }) => { calls.push({ source, title, body, dedupeKey }); },
  }), "published");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].dedupeKey, "oilprice:result:江西:2026-08-14");
  assert.deepEqual(repository.value?.fuels, { p92: "8.04", p95: "8.46", p0: "7.69" });
  assert.equal(repository.value?.lastProcessedWindow, "2026-08-14");

  const following = nextObservation({
    providerEffectiveDate: "2026-08-29",
    windowDate: "2026-08-28",
    nextWindowDate: "2026-09-11",
    fuels: {
      p92: { current: "8.14", previous: "8.04", change: "0.10" },
      p95: { current: "8.44", previous: "8.46", change: "-0.02" },
      p0: { current: "7.72", previous: "7.69", change: "0.03" },
    },
  });
  assert.equal(await observeOilPrice(following, {
    observedAt: new Date("2026-08-29T01:00:00.000Z"), repository,
    publish: async ({ source, title, body, dedupeKey }) => { calls.push({ source, title, body, dedupeKey }); },
  }), "published");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].dedupeKey, "oilprice:result:江西:2026-08-28");
});

test("an all-zero new window remains retryable for 48 hours without advancing the baseline", async () => {
  const repository = memoryRepository(structuredClone(baselineState));
  let publishes = 0;

  const outcome = await observeOilPrice(strandedObservation(), {
    observedAt: new Date("2026-08-16T15:59:59.999Z"),
    repository,
    publish: async () => { publishes += 1; },
  });

  assert.equal(outcome, "retry");
  assert.equal(publishes, 0);
  // 连续 retry 计数写入 state（未达告警阈值）
  assert.deepEqual(repository.value, { ...baselineState, retryCount: 1 });
});

test("incomplete evidence and JUHE snapshots do not publish", async () => {
  const cases: Array<{ observation: OilPriceObservation; at: Date; expected?: OilPriceState }> = [
    // 证据不全（仅 p92）：completeAdjustmentEvidence 失败 → retry 不发布，重试计数写入
    {
      observation: nextObservation({ fuels: { p92: nextObservation().fuels.p92 } as TianApiOilPrice["fuels"] }),
      at: new Date("2026-08-15T01:00:00.000Z"),
      expected: { ...baselineState, retryCount: 1 },
    },
    { observation: juheObservation(), at: new Date("2026-08-15T01:00:00.000Z") },
  ];

  for (const entry of cases) {
    const repository = memoryRepository(structuredClone(baselineState));
    let publishes = 0;
    const outcome = await observeOilPrice(entry.observation, {
      observedAt: entry.at, repository, publish: async () => { publishes += 1; },
    });
    assert.notEqual(outcome, "published");
    assert.equal(publishes, 0);
    assert.deepEqual(repository.value, entry.expected ?? baselineState);
  }
});

test("an all-zero late window is delayed-published once after 48 hours without backfilling", async () => {
  const repository = memoryRepository({
    ...baselineState,
    lastProcessedWindow: "2026-07-31",
  });
  const notifications: Array<{ dedupeKey: string; title: string }> = [];

  const outcome = await observeOilPrice(strandedObservation(), {
    observedAt: new Date("2026-08-16T16:00:00.001Z"),
    repository,
    publish: async ({ dedupeKey, title }) => { notifications.push({ dedupeKey, title }); },
  });

  // 超窗（>48h）不再静默丢弃：证据完整则延迟发布一次，标题标注"延迟发布"
  assert.equal(outcome, "published");
  assert.deepEqual(notifications, [{
    dedupeKey: "oilprice:result:江西:2026-08-14",
    title: "江西油价调整结果已发布（延迟发布）",
  }]);
  assert.deepEqual(repository.value, {
    schemaVersion: 1,
    initialized: true,
    province: "江西",
    unit: "元/升",
    provider: "TianAPI",
    fuels: { p92: "7.93", p95: "8.51", p0: "7.69" },
    providerEffectiveDate: "2026-08-15",
    windowDate: "2026-08-14",
    observedAt: "2026-08-17T00:00:00.001+08:00",
    lastProcessedWindow: "2026-07-31",
  });
});

test("a complete late result is delayed-published and the next window can still publish", async () => {
  const repository = memoryRepository({
    ...baselineState,
    lastProcessedWindow: "2026-07-31",
  });
  const notifications: Array<{ dedupeKey: string; title: string }> = [];

  const lateOutcome = await observeOilPrice(nextObservation(), {
    observedAt: new Date("2026-08-17T16:00:00.001Z"),
    repository,
    publish: async ({ dedupeKey, title }) => { notifications.push({ dedupeKey, title }); },
  });

  assert.equal(lateOutcome, "published");
  assert.deepEqual(notifications, [{
    dedupeKey: "oilprice:result:江西:2026-08-14",
    title: "江西油价调整结果已发布（延迟发布）",
  }]);
  assert.deepEqual(repository.value, {
    schemaVersion: 1,
    initialized: true,
    province: "江西",
    unit: "元/升",
    provider: "TianAPI",
    fuels: { p92: "8.03", p95: "8.46", p0: "7.69" },
    providerEffectiveDate: "2026-08-15",
    windowDate: "2026-08-14",
    observedAt: "2026-08-18T00:00:00.001+08:00",
    lastProcessedWindow: "2026-07-31",
  });

  const following = nextObservation({
    providerEffectiveDate: "2026-08-29",
    windowDate: "2026-08-28",
    nextWindowDate: "2026-09-11",
    fuels: {
      p92: { current: "8.13", previous: "8.03", change: "0.10" },
      p95: { current: "8.44", previous: "8.46", change: "-0.02" },
      p0: { current: "7.72", previous: "7.69", change: "0.03" },
    },
  });
  assert.equal(await observeOilPrice(following, {
    observedAt: new Date("2026-08-29T01:00:00.000Z"),
    repository,
    publish: async ({ dedupeKey, title }) => { notifications.push({ dedupeKey, title }); },
  }), "published");
  assert.deepEqual(notifications.map(({ dedupeKey }) => dedupeKey), [
    "oilprice:result:江西:2026-08-14",
    "oilprice:result:江西:2026-08-28",
  ]);
  assert.equal(repository.value?.lastProcessedWindow, "2026-08-28");
});

test("the watch publishes an advance notice before rejecting a provider failure", async () => {
  const calls: Array<{ source: string; dedupeKey: string }> = [];
  await assert.rejects(
    runOilPriceWatch({
      at: new Date("2026-08-13T01:00:00.000Z"),
      getLocation: () => ({ city: "萍乡市安源区" }),
      fetchPrice: async () => { throw new Error("fixture provider unavailable"); },
      repository: memoryRepository(),
      publish: async ({ source, dedupeKey }) => { calls.push({ source, dedupeKey }); },
    }),
    /fixture provider unavailable/,
  );

  assert.deepEqual(calls, [{ source: "oilprice", dedupeKey: "oilprice:advance:2026-08-14" }]);
});

test("advance notice starts strictly inside 40 hours and does not block provider observation", async () => {
  const calls: string[] = [];
  const repository = memoryRepository();
  await runOilPriceWatch({
    at: new Date("2026-08-13T00:00:00.000Z"),
    getLocation: () => null,
    publish: async ({ dedupeKey }) => { calls.push(dedupeKey); },
  });
  assert.deepEqual(calls, []);

  let fetched = false;
  await assert.rejects(
    runOilPriceWatch({
      at: new Date("2026-08-13T01:00:00.000Z"),
      getLocation: () => ({ city: "萍乡" }),
      fetchPrice: async () => {
        fetched = true;
        return tianObservation();
      },
      repository,
      publish: async () => { throw new Error("fixture advance publish failure"); },
    }),
    /fixture advance publish failure/,
  );
  assert.equal(fetched, true);
  assert.equal(repository.value?.windowDate, "2026-07-31");
});

test("the watch aggregates failures after attempting both independent paths", async () => {
  let publishAttempted = false;
  let fetchAttempted = false;

  await assert.rejects(
    runOilPriceWatch({
      at: new Date("2026-08-13T01:00:00.000Z"),
      getLocation: () => ({ city: "萍乡" }),
      fetchPrice: async () => {
        fetchAttempted = true;
        throw new Error("fixture provider failure");
      },
      publish: async () => {
        publishAttempted = true;
        throw new Error("fixture advance failure");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((cause) => cause instanceof Error ? cause.message : String(cause)),
        ["fixture advance failure", "fixture provider failure"],
      );
      return true;
    },
  );
  assert.equal(publishAttempted, true);
  assert.equal(fetchAttempted, true);
});

test("the watch passes the detected province to the oil-price provider", async () => {
  let fetched: { city: string; province?: string } | undefined;

  await runOilPriceWatch({
    at: new Date("2026-08-07T01:00:00.000Z"),
    getLocation: () => ({ city: "朔城区", province: "山西省" }),
    fetchPrice: async (city, options) => {
      fetched = { city, province: options?.province };
      return tianObservation({ province: "山西" });
    },
    repository: memoryRepository(),
    publish: async () => {},
  });

  assert.deepEqual(fetched, { city: "朔城区", province: "山西省" });
});

test("after the window table is exhausted the watch keeps observing and advances via candidate windows", async () => {
  // 2027 年已超出 2026 静态窗口表：nextWindow 返回按"每 10 个工作日"规则生成的候选窗口，
  // 观察链路继续跑；候选窗口带 calibrated: false，通知/日志标注"候选未校准"。
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    // 距候选窗口 >40h（2027-01-07 生效前 63h）：不发 advance、不抛错，油价观测继续
    const repository = memoryRepository();
    const calls: string[] = [];
    let fetched = false;
    await runOilPriceWatch({
      at: new Date("2027-01-05T01:00:00.000Z"),
      getLocation: () => ({ city: "萍乡" }),
      fetchPrice: async () => {
        fetched = true;
        return tianObservation();
      },
      repository,
      publish: async ({ dedupeKey }) => { calls.push(dedupeKey); },
    });
    assert.equal(fetched, true);
    assert.deepEqual(calls, []);
    assert.equal(repository.value?.province, "江西");
    assert.equal(repository.value?.schemaVersion, 1);

    // 距候选窗口 <40h（2027-01-07 生效前 15h）：用候选窗口发 advance，标题标注"候选未校准"
    const notices: Array<{ dedupeKey: string; title: string }> = [];
    await runOilPriceWatch({
      at: new Date("2027-01-07T01:00:00.000Z"),
      getLocation: () => ({ city: "萍乡" }),
      fetchPrice: async () => tianObservation(),
      repository: memoryRepository(),
      publish: async ({ dedupeKey, title }) => { notices.push({ dedupeKey, title }); },
    });
    assert.deepEqual(notices, [{
      dedupeKey: "oilprice:advance:2027-01-07",
      title: "下一轮油价调整窗口：2027年1月7日（候选未校准）",
    }]);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((line) => line.includes("uncalibrated candidate adjustment window 2027-01-07")));
});

test("a corrupted persisted state is rebuilt as a baseline instead of failing daily", async () => {
  // 旧格式/损坏 state（缺 schemaVersion、缺 p0 燃料）：校验失败后按不存在处理并重建 baseline
  const repository = memoryRepository({
    initialized: true,
    province: "江西",
    unit: "元/升",
    provider: "TianAPI",
    fuels: { p92: "7.93", p95: "8.51" } as Record<"p92" | "p95" | "p0", string>,
    observedAt: "2026-08-07T09:00:00+08:00",
  } as unknown as OilPriceState);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const outcome = await observeOilPrice(tianObservation(), {
      observedAt: new Date("2026-08-08T01:00:00.000Z"),
      repository,
      publish: async () => {},
    });
    assert.equal(outcome, "baseline");
    assert.equal(repository.value?.schemaVersion, 1);
    assert.equal(repository.value?.observedAt, "2026-08-08T09:00:00+08:00");
    assert.deepEqual(repository.value?.fuels, { p92: "7.93", p95: "8.51", p0: "7.69" });
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) => line.includes("invalid persisted state; rebuilding baseline")));
});

test("a provider window date deviating from the static table warns but still observes", async () => {
  // 观测窗口日与静态表最近窗口（2026-07-31）偏差超过 1 天：只 console.error 告警，不失败
  const repository = memoryRepository();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const outcome = await observeOilPrice(
      tianObservation({ windowDate: "2026-07-25", providerEffectiveDate: "2026-07-26" }),
      {
        observedAt: new Date("2026-08-07T01:00:00.000Z"),
        repository,
        publish: async () => {},
      },
    );
    assert.equal(outcome, "baseline");
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) => line.includes("provider window date deviates from static table")));
});

test("a provider window date within one day of the nearest table window stays silent", async () => {
  // ±1 天容差：与静态表最近窗口相差 1 天的观测不应触发告警（last_adjusted 语义歧义）
  const repository = memoryRepository();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const outcome = await observeOilPrice(
      tianObservation({ windowDate: "2026-08-01", providerEffectiveDate: "2026-08-02" }),
      {
        observedAt: new Date("2026-08-07T01:00:00.000Z"),
        repository,
        publish: async () => {},
      },
    );
    assert.equal(outcome, "baseline");
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 0);
});

test("a one-cent rounding deviation is accepted end to end and publishes the official result", async () => {
  // provider 与 watch 必须同口径：±1 分舍入偏差允许发布，2 分偏差仍拒绝（retry）
  const repository = memoryRepository(structuredClone(baselineState));
  const calls: string[] = [];
  const outcome = await observeOilPrice(nextObservation({
    fuels: {
      p92: { current: "8.03", previous: "7.93", change: "0.09" },   // 差值 0.10，偏差 +1 分
      p95: { current: "8.46", previous: "8.51", change: "-0.04" },  // 差值 -0.05，偏差 +1 分
      p0: { current: "7.69", previous: "7.69", change: "0.00" },
    },
  }), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"),
    repository,
    publish: async ({ dedupeKey }) => { calls.push(dedupeKey); },
  });
  assert.equal(outcome, "published");
  assert.deepEqual(calls, ["oilprice:result:江西:2026-08-14"]);

  const twoCent = memoryRepository(structuredClone(baselineState));
  const twoCentCalls: string[] = [];
  assert.equal(await observeOilPrice(nextObservation({
    fuels: {
      p92: { current: "8.03", previous: "7.93", change: "0.08" },   // 差值 0.10，偏差 2 分
      p95: { current: "8.46", previous: "8.51", change: "-0.05" },
      p0: { current: "7.69", previous: "7.69", change: "0.00" },
    },
  }), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"),
    repository: twoCent,
    publish: async ({ dedupeKey }) => { twoCentCalls.push(dedupeKey); },
  }), "retry");
  assert.equal(twoCentCalls.length, 0);
});

test("a one-cent previous price deviation from the persisted baseline still publishes", async () => {
  // completeAndConsistent 的 previous 对照与 completeAdjustmentEvidence 同口径（cents ±1 分）：
  // 1 分偏差仍发布，2 分偏差仍 retry
  const repository = memoryRepository(structuredClone(baselineState));
  const calls: string[] = [];
  const outcome = await observeOilPrice(nextObservation({
    fuels: {
      p92: { current: "8.03", previous: "7.92", change: "0.11" }, // previous 与 state 差 1 分
      p95: { current: "8.46", previous: "8.51", change: "-0.05" },
      p0: { current: "7.69", previous: "7.69", change: "0.00" },
    },
  }), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"),
    repository,
    publish: async ({ dedupeKey }) => { calls.push(dedupeKey); },
  });
  assert.equal(outcome, "published");
  assert.deepEqual(calls, ["oilprice:result:江西:2026-08-14"]);

  const twoCent = memoryRepository(structuredClone(baselineState));
  const twoCentCalls: string[] = [];
  assert.equal(await observeOilPrice(nextObservation({
    fuels: {
      p92: { current: "8.03", previous: "7.91", change: "0.12" }, // previous 与 state 差 2 分
      p95: { current: "8.46", previous: "8.51", change: "-0.05" },
      p0: { current: "7.69", previous: "7.69", change: "0.00" },
    },
  }), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"),
    repository: twoCent,
    publish: async ({ dedupeKey }) => { twoCentCalls.push(dedupeKey); },
  }), "retry");
  assert.equal(twoCentCalls.length, 0);
});

test("a same-window complete re-observation publishes the official result once", async () => {
  // 同窗完全证据路径不再静默"ignored"：直接发布（identity 含 windowDate 防重），不推进 lastProcessedWindow
  const repository = memoryRepository(structuredClone(baselineState));
  const calls: Array<{ dedupeKey: string; title: string }> = [];
  const outcome = await observeOilPrice(tianObservation(), {
    observedAt: new Date("2026-08-08T01:00:00.000Z"),
    repository,
    publish: async ({ dedupeKey, title }) => { calls.push({ dedupeKey, title }); },
  });

  assert.equal(outcome, "published");
  assert.deepEqual(calls, [{
    dedupeKey: "oilprice:result:江西:2026-07-31",
    title: "江西油价已上调，92号每升上涨0.55元",
  }]);
  assert.equal(repository.value?.windowDate, "2026-07-31");
  assert.equal(repository.value?.lastProcessedWindow, undefined);
});

test("persistent retries increment the state counter and warn after the threshold", async () => {
  const repository = memoryRepository(structuredClone(baselineState));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await observeOilPrice(strandedObservation(), {
        observedAt: new Date("2026-08-16T10:00:00.000Z"),
        repository,
        publish: async () => {},
      }), "retry");
    }
    assert.equal(repository.value?.retryCount, 3);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((line) => line.includes("3 consecutive retries for 江西")));
});

test("a successful publish clears the persisted retry count", async () => {
  const repository = memoryRepository({ ...baselineState, retryCount: 5 });
  const outcome = await observeOilPrice(nextObservation(), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"),
    repository,
    publish: async () => {},
  });
  assert.equal(outcome, "published");
  assert.equal(repository.value?.retryCount, undefined);
  assert.equal(repository.value?.lastProcessedWindow, "2026-08-14");
});

test("a complete pre-upgrade state without schemaVersion keeps the in-flight window flow", async () => {
  // 升级兼容：字段完整仅缺 schemaVersion 的旧 state 应直接走发布流程，
  // 而不是被当作损坏重建 baseline（那样会吞掉一个在途窗口的正式结果）
  const { schemaVersion: _dropped, ...legacyState } = structuredClone(baselineState);
  const repository = memoryRepository(legacyState as OilPriceState);
  const calls: string[] = [];
  const outcome = await observeOilPrice(nextObservation(), {
    observedAt: new Date("2026-08-15T01:00:00.000Z"),
    repository,
    publish: async ({ dedupeKey }) => { calls.push(dedupeKey); },
  });
  assert.equal(outcome, "published");
  assert.deepEqual(calls, ["oilprice:result:江西:2026-08-14"]);
  assert.equal(repository.value?.schemaVersion, 1);
});