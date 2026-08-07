import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { fetchOilPrice, provinceOf } from "../src/modules/oilprice/provider.js";

const marketFixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/tianapi-oilprice-market-jiangxi.json", import.meta.url),
  "utf8",
));
const juheFixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/juhe-oilprice-provinces.json", import.meta.url),
  "utf8",
));

test("city-to-province normalization handles a city suffix, district path, and direct province name", () => {
  assert.equal(provinceOf("萍乡市"), "江西");
  assert.equal(provinceOf("萍乡市安源区"), "江西");
  assert.equal(provinceOf("江西省"), "江西");
  assert.equal(provinceOf("江西"), "江西");
});

test("an explicit detected province resolves a district that is absent from the city map", async () => {
  const fixture = structuredClone(marketFixture);
  fixture.result.prov = "山西";
  const urls: string[] = [];

  const result = await fetchOilPrice("朔城区", {
    province: "山西省",
    tianapiKey: "fixture-key",
    juheKey: "",
    httpJson: async (url) => {
      urls.push(url);
      return fixture;
    },
  });

  assert.equal(new URL(urls[0]).searchParams.get("prov"), "山西");
  assert.equal(result.province, "山西");
});

test("TianAPI market maps adjustment evidence and normalizes effective dates to Shanghai window dates", async () => {
  const urls: string[] = [];
  const result = await fetchOilPrice("萍乡市安源区", {
    tianapiKey: "fixture-key",
    juheKey: "",
    httpJson: async (url) => {
      urls.push(url);
      return structuredClone(marketFixture);
    },
  });

  assert.match(urls[0], /^https:\/\/apis\.tianapi\.com\/oilprice\/market\?/);
  assert.deepEqual(result, {
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
  });
});

test("TianAPI market validates prices and changes using exact cents", async () => {
  const invalidCases = [
    { field: "price", value: "7.931", message: /p92\.price.*decimal/ },
    { field: "previous_price", value: "NaN", message: /p92\.previous_price.*decimal/ },
    { field: "price_change", value: 0.54, message: /p92.*difference/ },
    { field: "price", value: 0, message: /p92\.price.*positive/ },
  ] as const;

  for (const invalid of invalidCases) {
    const fixture = structuredClone(marketFixture);
    fixture.result.p92[invalid.field] = invalid.value;
    await assert.rejects(
      fetchOilPrice("萍乡", {
        tianapiKey: "fixture-key",
        juheKey: "",
        httpJson: async () => fixture,
      }),
      invalid.message,
    );
  }
});

test("TianAPI market rejects a province that differs from the normalized request", async () => {
  const fixture = structuredClone(marketFixture);
  fixture.result.prov = "湖南";

  await assert.rejects(
    fetchOilPrice("萍乡市安源区", {
      tianapiKey: "fixture-key",
      juheKey: "",
      httpJson: async () => fixture,
    }),
    /province.*江西.*湖南|湖南.*江西.*province/i,
  );
});

test("TianAPI transport errors do not expose request URL query secrets", async () => {
  await assert.rejects(
    fetchOilPrice("萍乡", {
      tianapiKey: "fixture-secret-key",
      juheKey: "",
      httpJson: async (url) => {
        throw new Error(`HTTP 500 for ${url}`);
      },
    }),
    (error: Error) => {
      assert.equal(error.message, "TianAPI oil-price request failed");
      assert.doesNotMatch(error.message, /fixture-secret-key/);
      assert.doesNotMatch(error.message, /\?key=/);
      return true;
    },
  );
});

test("JUHE fallback normalizes a district location to its province and has no adjustment evidence", async () => {
  const urls: string[] = [];
  const result = await fetchOilPrice("萍乡市安源区", {
    tianapiKey: "fixture-key",
    juheKey: "fallback-key",
    httpJson: async (url) => {
      urls.push(url);
      if (url.includes("tianapi")) throw new Error("fixture TianAPI failure");
      return structuredClone(juheFixture);
    },
  });

  assert.match(urls[1], /^https:\/\/apis\.juhe\.cn\/gnyj\/query\?/);
  assert.deepEqual(result, {
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
  });
});

test("JUHE rejects string zero and non-zero error_code values even when a result array is present", async () => {
  for (const errorCode of ["0", 10001]) {
    const fixture = structuredClone(juheFixture);
    fixture.reason = "KEY ERROR";
    fixture.error_code = errorCode;

    await assert.rejects(
      fetchOilPrice("萍乡", {
        tianapiKey: "",
        juheKey: "fallback-key",
        httpJson: async () => fixture,
      }),
      new RegExp(`JUHE.*${errorCode}|${errorCode}.*JUHE`),
    );
  }
});

test("JUHE rejects resultcode 200 with a valid result when error_code is missing", async () => {
  const fixture = structuredClone(juheFixture);
  fixture.resultcode = "200";
  delete fixture.error_code;

  await assert.rejects(
    fetchOilPrice("萍乡", {
      tianapiKey: "",
      juheKey: "fallback-key",
      httpJson: async () => fixture,
    }),
    /JUHE.*200|200.*JUHE/,
  );
});

test("JUHE transport errors do not expose request URL query secrets", async () => {
  await assert.rejects(
    fetchOilPrice("萍乡", {
      tianapiKey: "",
      juheKey: "fixture-secret-key",
      httpJson: async (url) => {
        throw new Error(`HTTP 503 for ${url}`);
      },
    }),
    (error: Error) => {
      assert.equal(error.message, "JUHE oil-price request failed");
      assert.doesNotMatch(error.message, /fixture-secret-key/);
      assert.doesNotMatch(error.message, /\?key=/);
      return true;
    },
  );
});

test("provider URLs use HTTPS and encode TianAPI and JUHE keys", async () => {
  const urls: string[] = [];
  await fetchOilPrice("萍乡", {
    tianapiKey: "tian key&scope=wrong",
    juheKey: "juhe key&scope=wrong",
    httpJson: async (url) => {
      urls.push(url);
      if (url.includes("tianapi")) throw new Error("use fallback");
      return structuredClone(juheFixture);
    },
  });

  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith("https://")));
  assert.equal(new URL(urls[0]).searchParams.get("key"), "tian key&scope=wrong");
  assert.equal(new URL(urls[0]).searchParams.get("prov"), "江西");
  assert.equal(new URL(urls[1]).searchParams.get("key"), "juhe key&scope=wrong");
});

test("an unconfigured oil-price provider fails explicitly", async () => {
  await assert.rejects(
    fetchOilPrice("萍乡", { tianapiKey: "", juheKey: "", httpJson: async () => ({}) }),
    /oil-price provider is not configured/,
  );
});
