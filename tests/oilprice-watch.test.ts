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
    publish: async (source, title, body, dedupeKey) => { calls.push({ source, title, body, dedupeKey }); },
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
  assert.equal(await observeOilPrice(revised, {
    observedAt: new Date("2026-08-15T02:00:00.000Z"), repository,
    publish: async (source, title, body, dedupeKey) => { calls.push({ source, title, body, dedupeKey }); },
  }), "ignored");
  assert.equal(calls.length, 1);
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
    publish: async (source, title, body, dedupeKey) => { calls.push({ source, title, body, dedupeKey }); },
  }), "published");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].dedupeKey, "oilprice:result:江西:2026-08-28");
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
  assert.deepEqual(repository.value, baselineState);
});

test("unchanged provider window, incomplete evidence, and previous mismatch do not publish", async () => {
  const cases: Array<{ observation: OilPriceObservation; at: Date; expected?: OilPriceState }> = [
    {
      observation: tianObservation(),
      at: new Date("2026-08-08T01:00:00.000Z"),
      expected: { ...baselineState, observedAt: "2026-08-08T09:00:00+08:00" },
    },
    { observation: nextObservation({ fuels: { p92: nextObservation().fuels.p92 } as TianApiOilPrice["fuels"] }), at: new Date("2026-08-15T01:00:00.000Z") },
    { observation: nextObservation({ fuels: { ...nextObservation().fuels, p92: { current: "8.03", previous: "7.92", change: "0.11" } } }), at: new Date("2026-08-15T01:00:00.000Z") },
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

test("an all-zero window quietly advances the baseline after 48 hours without backfilling", async () => {
  const repository = memoryRepository({
    ...baselineState,
    lastProcessedWindow: "2026-07-31",
  });
  const calls: string[] = [];

  const outcome = await observeOilPrice(strandedObservation(), {
    observedAt: new Date("2026-08-16T16:00:00.001Z"),
    repository,
    publish: async (_source, _title, _body, dedupeKey) => { calls.push(dedupeKey); },
  });

  assert.equal(outcome, "baseline");
  assert.deepEqual(calls, []);
  assert.deepEqual(repository.value, {
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

test("a complete late result quietly advances the baseline so the next window can publish", async () => {
  const repository = memoryRepository({
    ...baselineState,
    lastProcessedWindow: "2026-07-31",
  });
  const calls: string[] = [];

  const lateOutcome = await observeOilPrice(nextObservation(), {
    observedAt: new Date("2026-08-17T16:00:00.001Z"),
    repository,
    publish: async (_source, _title, _body, dedupeKey) => { calls.push(dedupeKey); },
  });

  assert.equal(lateOutcome, "baseline");
  assert.deepEqual(calls, []);
  assert.deepEqual(repository.value, {
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
    publish: async (_source, _title, _body, dedupeKey) => { calls.push(dedupeKey); },
  }), "published");
  assert.deepEqual(calls, ["oilprice:result:江西:2026-08-28"]);
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
      publish: async (source, _title, _body, dedupeKey) => { calls.push({ source, dedupeKey }); },
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
    publish: async (_source, _title, _body, dedupeKey) => { calls.push(dedupeKey); },
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
