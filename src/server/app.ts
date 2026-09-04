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

/** CORS 白名单：默认只放行本机回环（127.0.0.1 / localhost / [::1] 任意端口）。
 * 需要额外来源时用 WEBCORS_ORIGIN（逗号分隔）扩展；Origin 不匹配则不加 CORS 头（浏览器侧拦截）。 */
function allowedCorsOrigins(): Set<string> {
  const origins = new Set<string>(["127.0.0.1", "localhost", "[::1]"]);
  const extra = process.env.WEBCORS_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of extra ?? []) origins.add(origin);
  return origins;
}

function originAllowed(requestOrigin: string | undefined): boolean {
  if (!requestOrigin) return false;
  try {
    const url = new URL(requestOrigin);
    const allowed = allowedCorsOrigins();
    return allowed.has(url.hostname) || allowed.has(requestOrigin) || allowed.has(url.origin);
  } catch {
    return false;
  }
}

export function createApp(options?: { profile?: string; apiToken?: string }) {
  const app = new Hono<AppEnv>();
  const apiToken = options?.apiToken ?? process.env.WEB_API_TOKEN;

  // 安全响应头：杜绝 MIME 嗅探、点击劫持与 referrer 泄漏。
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
  });

  // CORS & 预检 OPTIONS：默认仅放行本机回环或配置来源；
  // 必须先于 Token 鉴权中间件执行，避免浏览器发送的无 Token 预检被 401 拦截。
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (originAllowed(origin)) {
      c.header("Access-Control-Allow-Origin", origin!);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (c.req.method === "OPTIONS") {
      return originAllowed(origin) ? c.body(null, 204) : c.body(null, 403);
    }
    await next();
  });

  // 可选 Token 鉴权：仅当配置了 WEB_API_TOKEN 时启用，未配置则保持本机零配置可用。
  // 校验先于任何路由处理，避免未授权请求触达领域逻辑（只读 API 亦如此）。
  app.use("/api/*", async (c, next) => {
    if (!apiToken) return next();
    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const queryToken = c.req.query("token");
    if (bearer !== apiToken && queryToken !== apiToken) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

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
