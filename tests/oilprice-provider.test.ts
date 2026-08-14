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
    // 校验放宽为 ±1 分：0.54 相对 0.55 仅差 1 分会被接受，0.53 差 2 分仍拒绝
    { field: "price_change", value: 0.53, message: /p92.*difference/ },
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
      // 传输层错误被内层 catch 转为固定文案，外层再附前缀；仍不暴露 URL 与密钥
      assert.equal(error.message, "TianAPI oil-price failed: TianAPI oil-price request failed");
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

test("city-to-province normalization covers the expanded prefecture map", () => {
  const cases: Array<[string, string]> = [
    ["徐州", "江苏"], ["常州", "江苏"], ["南通", "江苏"], ["扬州", "江苏"], ["盐城", "江苏"],
    ["镇江", "江苏"], ["泰州", "江苏"], ["宿迁", "江苏"], ["淮安", "江苏"], ["连云港", "江苏"],
    ["绍兴", "浙江"], ["嘉兴", "浙江"], ["金华", "浙江"], ["台州", "浙江"], ["湖州", "浙江"],
    ["中山", "广东"], ["惠州", "广东"], ["江门", "广东"], ["汕头", "广东"],
    ["绵阳", "四川"], ["德阳", "四川"], ["宜宾", "四川"], ["泸州", "四川"],
    ["洛阳", "河南"], ["开封", "河南"], ["南阳", "河南"],
    ["唐山", "河北"], ["保定", "河北"], ["邯郸", "河北"],
    ["烟台", "山东"], ["潍坊", "山东"], ["临沂", "山东"],
    ["泉州", "福建"], ["漳州", "福建"],
    ["襄阳", "湖北"], ["宜昌", "湖北"],
    ["株洲", "湖南"], ["湘潭", "湖南"],
    ["芜湖", "安徽"], ["马鞍山", "安徽"],
    ["桂林", "广西"], ["柳州", "广西"],
    ["遵义", "贵州"], ["大理", "云南"], ["三亚", "海南"], ["包头", "内蒙古"],
    ["香港", "香港"], ["澳门", "澳门"], ["台湾", "台湾"],
  ];
  for (const [city, province] of cases) {
    assert.equal(provinceOf(city), province, `provinceOf(${city})`);
  }
  // 后缀剥离逻辑保持可用：新加入的省份名同样支持"省/市"后缀
  assert.equal(provinceOf("香港特别行政区"), "香港");
  assert.equal(provinceOf("台湾省"), "台湾");
  assert.equal(provinceOf("徐州市"), "江苏");
});

test("TianAPI accepts a one-cent deviation between price difference and price_change", async () => {
  const fixture = structuredClone(marketFixture);
  fixture.result.p92.price_change = 0.54; // 7.93 - 7.38 = 0.55，允许 ±1 分偏差
  const result = await fetchOilPrice("萍乡", {
    tianapiKey: "fixture-key",
    juheKey: "",
    httpJson: async () => fixture,
  });
  assert.equal(result.fuels.p92.change, "0.54");
});

test("a JUHE fallback failure reports the captured TianAPI error", async () => {
  await assert.rejects(
    fetchOilPrice("萍乡", {
      tianapiKey: "fixture-key",
      juheKey: "fallback-key",
      httpJson: async (url) => {
        if (url.includes("tianapi")) throw new Error("fixture TianAPI failure");
        return { reason: "KEY ERROR", error_code: 10001 };
      },
    }),
    /JUHE oil-price query failed: 10001 KEY ERROR \(TianAPI: TianAPI oil-price request failed\)/,
  );
});

test("an unknown province hints at location.detect in the not-configured error", async () => {
  await assert.rejects(
    fetchOilPrice("未知地名", { tianapiKey: "", juheKey: "", httpJson: async () => ({}) }),
    /oil-price provider is not configured.*location\.detect/s,
  );
});

test("an unknown province hints at location.detect when JUHE has no coverage", async () => {
  await assert.rejects(
    fetchOilPrice("未知地名", {
      tianapiKey: "",
      juheKey: "fallback-key",
      httpJson: async () => structuredClone(juheFixture),
    }),
    /does not cover 未知地名.*location\.detect/s,
  );
});
