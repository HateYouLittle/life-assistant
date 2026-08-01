import path from "node:path";

/** 全局配置：全部来自环境变量，密钥不落代码库 */
export const config = {
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),

  location: {
    city: process.env.LOCATION_CITY ?? "",
    lat: process.env.LOCATION_LAT ? Number(process.env.LOCATION_LAT) : undefined,
    lon: process.env.LOCATION_LON ? Number(process.env.LOCATION_LON) : undefined,
  },

  qweatherKey: process.env.QWEATHER_KEY ?? "",
  qweatherApiHost: process.env.QWEATHER_API_HOST ?? "devapi.qweather.com",
  juheKey: process.env.JUHE_KEY ?? "",
  tianapiKey: process.env.TIANAPI_KEY ?? "",

  kuaidi100: {
    customer: process.env.KUAIDI100_CUSTOMER ?? "",
    key: process.env.KUAIDI100_KEY ?? "",
  },

  notify: {
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL ?? "",
    barkUrl: process.env.BARK_URL ?? "",
    serverchanSendKey: process.env.SERVERCHAN_SENDKEY ?? "",
  },

  /** 调度周期（cron 表达式），可在模块注册时覆盖 */
  cron: {
    weatherAlerts: "*/15 * * * *",
    oilWatch: "0 9 * * *",
    expressPoll: "0 * * * *",
  },
};
