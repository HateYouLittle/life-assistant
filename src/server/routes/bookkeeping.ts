import { Hono } from "hono";
import {
  listAccounts,
  listEntries,
  listLedgers,
  summarizeLedger,
} from "../../modules/bookkeeping/service.js";
import type { AppEnv } from "../types.js";

export const bookkeepingRoute = new Hono<AppEnv>();

bookkeepingRoute.get("/", (c) => {
  const profile =
    c.req.query("profile") ||
    c.get("defaultProfile") ||
    process.env.HERMES_PROFILE ||
    "default";
  const month = c.req.query("month");

  const accounts = listAccounts(profile);
  const summary = summarizeLedger(profile, undefined, month);
  const entries = listEntries(profile, undefined, { limit: 50 });
  const ledgers = listLedgers(profile);

  return c.json({
    profile,
    accounts,
    summary,
    entries,
    ledgers,
  });
});
