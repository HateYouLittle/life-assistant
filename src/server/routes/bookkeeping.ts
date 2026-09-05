import { Hono } from "hono";
import { DateTime } from "luxon";
import {
  listAccounts,
  listEntries,
  listLedgers,
  listProfileEntries,
  summarizeLedger,
  summarizeProfileLedgers,
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
  const ledgerId = c.req.query("ledgerId");

  let from: string | undefined;
  let to: string | undefined;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const dt = DateTime.fromISO(`${month}-01`, { zone: "Asia/Shanghai" });
    if (dt.isValid) {
      from = dt.startOf("month").toISO()!;
      to = dt.endOf("month").toISO()!;
    }
  }

  const accounts = listAccounts(profile, ledgerId);
  const summary = ledgerId
    ? summarizeLedger(profile, ledgerId, month)
    : summarizeProfileLedgers(profile, month);
  const entries = ledgerId
    ? listEntries(profile, ledgerId, { from, to, limit: 50 })
    : listProfileEntries(profile, { from, to, limit: 50 });
  const ledgers = listLedgers(profile);

  return c.json({
    profile,
    accounts,
    summary,
    entries,
    ledgers,
  });
});
