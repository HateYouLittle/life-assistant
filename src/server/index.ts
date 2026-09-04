import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3080;
const host = process.env.HOST || "0.0.0.0";

serve({ fetch: createApp().fetch, port, hostname: host }, (info) => {
  console.log(`[life-assistant-web] Server listening on http://${info.address}:${info.port}`);
});
