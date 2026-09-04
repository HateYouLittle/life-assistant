import { Hono } from "hono";
import { listAutomations } from "../../modules/automation/service.js";
import type { AppEnv } from "../types.js";

export const automationsRoute = new Hono<AppEnv>();

automationsRoute.get("/", (c) => {
  const profile =
    c.req.query("profile") ||
    c.get("defaultProfile") ||
    process.env.HERMES_PROFILE ||
    "default";
  const enabled = c.req.query("enabled");
  const items = listAutomations(
    profile,
    enabled !== undefined ? { enabled: enabled === "true" } : {},
  );

  return c.json({
    profile,
    total: items.length,
    items,
  });
});
