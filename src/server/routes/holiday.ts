import { Hono } from "hono";
import { DateTime } from "luxon";
import { dayInfo, holidayYearView, nextHoliday } from "../../modules/holiday/calendar.js";

export const holidayRoute = new Hono();

holidayRoute.get("/", (c) => {
  const todayIso = DateTime.now().setZone("Asia/Shanghai").toISODate()!;
  const today = dayInfo(todayIso);
  const next = nextHoliday();
  const year = holidayYearView(new Date().getFullYear()) ?? null;

  return c.json({
    today,
    next,
    year,
  });
});
