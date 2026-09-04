import fs from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { automationsRoute } from "./routes/automations.js";
import { bookkeepingRoute } from "./routes/bookkeeping.js";
import { healthRoute } from "./routes/health.js";
import { holidayRoute } from "./routes/holiday.js";
import { oilpriceRoute } from "./routes/oilprice.js";
import { overviewRoute } from "./routes/overview.js";
import { schedulesRoute } from "./routes/schedules.js";
import { weatherRoute } from "./routes/weather.js";
import type { AppEnv } from "./types.js";

export function createApp(options?: { profile?: string }) {
  const app = new Hono<AppEnv>();

  app.use("*", cors());

  if (options?.profile) {
    app.use("*", async (c, next) => {
      c.set("defaultProfile", options.profile);
      await next();
    });
  }

  app.onError((err, c) => {
    return c.json({ error: err.message }, 500);
  });

  app.route("/api/health", healthRoute);
  app.route("/api/overview", overviewRoute);
  app.route("/api/weather", weatherRoute);
  app.route("/api/oilprice", oilpriceRoute);
  app.route("/api/holiday", holidayRoute);
  app.route("/api/schedules", schedulesRoute);
  app.route("/api/bookkeeping", bookkeepingRoute);
  app.route("/api/automations", automationsRoute);

  // Static assets and SPA fallback
  if (fs.existsSync("./dist/web")) {
    app.use("/*", serveStatic({ root: "./dist/web" }));
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api")) {
        return next();
      }
      return serveStatic({ path: "./dist/web/index.html" })(c, next);
    });
  }

  return app;
}
