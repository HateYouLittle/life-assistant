import { Hono } from "hono";
import { fetchAirQuality } from "../../modules/airquality/provider.js";
import { currentLocation } from "../../modules/location/index.js";
import {
  fetchAlerts,
  fetchCurrent,
  fetchForecast,
  fetchIndices,
} from "../../modules/weather/provider.js";

export const weatherRoute = new Hono();

weatherRoute.get("/", async (c) => {
  const location = currentLocation();
  if (!location) {
    return c.json({ error: "location_not_set", location: null });
  }

  const [currentRes, forecastRes, airQualityRes, alertsRes, indicesRes] =
    await Promise.allSettled([
      fetchCurrent(location.lat, location.lon, location.city),
      fetchForecast(location.lat, location.lon, 7, location.city),
      fetchAirQuality(location.city, location.lat, location.lon),
      fetchAlerts(location.city, location.lat, location.lon),
      fetchIndices(location.city, location.lat, location.lon),
    ]);

  const current = currentRes.status === "fulfilled" ? currentRes.value : null;
  const forecast = forecastRes.status === "fulfilled" ? forecastRes.value : null;
  const airQuality = airQualityRes.status === "fulfilled" ? airQualityRes.value : null;
  const alerts = alertsRes.status === "fulfilled" ? alertsRes.value : null;
  const indices = indicesRes.status === "fulfilled" ? indicesRes.value : null;

  return c.json({
    location,
    current,
    forecast,
    airQuality,
    alerts,
    indices,
  });
});
