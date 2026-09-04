import { Hono } from "hono";
import type { AppEnv } from "../types.js";

export const healthRoute = new Hono<AppEnv>();

healthRoute.get("/", (c) => {
  const profile =
    c.req.query("profile") ||
    c.get("defaultProfile") ||
    process.env.HERMES_PROFILE ||
    "default";
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    profile,
  });
});
