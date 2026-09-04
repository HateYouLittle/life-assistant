import { Hono } from "hono";
import { listSchedules } from "../../modules/schedule/service.js";
import type { AppEnv } from "../types.js";

export const schedulesRoute = new Hono<AppEnv>();

schedulesRoute.get("/", (c) => {
  const profile =
    c.req.query("profile") ||
    c.get("defaultProfile") ||
    process.env.HERMES_PROFILE ||
    "default";
  const status = c.req.query("status");
  const type = c.req.query("type");
  const items = listSchedules(profile, {
    status: status as any,
    type: type as any,
  });

  return c.json({
    profile,
    total: items.length,
    items,
  });
});
