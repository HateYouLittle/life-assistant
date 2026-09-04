import { Hono } from "hono";
import { currentLocation } from "../../modules/location/index.js";
import { currentOilPriceResult, nextAdjustmentSummary } from "../../modules/oilprice/index.js";
import { fetchOilPrice } from "../../modules/oilprice/provider.js";

export const oilpriceRoute = new Hono();

oilpriceRoute.get("/", async (c) => {
  const location = currentLocation();
  let current = null;
  if (location) {
    try {
      const obs = await fetchOilPrice(location.city);
      current = currentOilPriceResult(obs);
    } catch {
      current = null;
    }
  }

  let nextAdjustment = null;
  try {
    nextAdjustment = nextAdjustmentSummary();
  } catch {
    nextAdjustment = null;
  }

  return c.json({
    location,
    current,
    nextAdjustment,
  });
});
