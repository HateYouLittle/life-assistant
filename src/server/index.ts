import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3080;
// 默认仅绑定本机回环：仪表盘 API 无内置认证，暴露到 0.0.0.0 会让外部任意访问者
// 通过 ?profile= 越权读取任意身份的数据。需要局域网/公网访问时显式设置 HOST=0.0.0.0，
// 同时应配置 WEB_API_TOKEN 做鉴权（见 README）。
const host = process.env.HOST || "127.0.0.1";
const apiToken = process.env.WEB_API_TOKEN;

serve({ fetch: createApp({ apiToken }).fetch, port, hostname: host }, (info) => {
  console.log(`[life-assistant-web] Server listening on http://${info.address}:${info.port}`);
});
