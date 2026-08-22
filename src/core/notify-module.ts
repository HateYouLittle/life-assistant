import { z } from "zod";
import { ok, registerModule, fail, type AssistantModule } from "./registry.js";
import {
  cancelProfileNotificationDelivery,
  listProfileNotifications,
  pullPending,
  snoozeProfileNotificationDelivery,
} from "./notifier.js";
import {
  clearQuietHours,
  getQuietHours,
  isValidTimeOfDay,
  saveQuietHours,
} from "./notification-settings.js";
import { requireProfileContext } from "./profile.js";

export const notifyModule: AssistantModule = {
  name: "notify",
  tools: [
    {
      name: "pull",
      description: "拉取当前 Hermes Profile 的未读通知：公共天气/油价通知和本 Profile 的私有日程通知。",
      schema: {},
      handler: async (_args, context) => {
        const notifications = pullPending(context ?? requireProfileContext());
        return ok({ count: notifications.length, notifications });
      },
    },
    {
      name: "list",
      description: "列出当前 Profile 最近的通知及各 route 的投递状态（sent/pending/failed/fallback/cancelled 等），只读操作，用于排查「为什么没收到通知」或挑选要推迟/取消的通知。",
      schema: { limit: z.number().int().min(1).max(100).optional().describe("返回条数，默认 20") },
      handler: async (args, context) => {
        const { limit } = z.object({ limit: z.number().int().min(1).max(100).optional() }).parse(args ?? {});
        return ok({ notifications: listProfileNotifications(context ?? requireProfileContext(), limit) });
      },
    },
    {
      name: "snooze",
      description: "把一条尚未成功投递的通知推迟 minutes 分钟（1–1440）再投递，如「这个提醒半小时后再说」。只对未投递成功且不在投递途中的通知有效；已投递成功或已取消的通知会返回错误说明。",
      schema: {
        notificationId: z.number().int().min(1).describe("notify.list 返回的通知 id"),
        minutes: z.number().int().min(1).max(1440).describe("推迟分钟数"),
      },
      handler: async (args, context) => {
        try {
          const parsed = z.object({
            notificationId: z.number().int().min(1),
            minutes: z.number().int().min(1).max(1440),
          }).parse(args);
          return ok(snoozeProfileNotificationDelivery(
            context ?? requireProfileContext(),
            parsed.notificationId,
            parsed.minutes,
          ));
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    },
    {
      name: "cancel",
      description: "取消一条通知的后续投递（用户明确表示不需要这条提醒时使用）。只影响尚未成功投递的 delivery，已 sent 的不受影响；取消后 notify.pull 也不会再复述该通知。",
      schema: { notificationId: z.number().int().min(1).describe("notify.list 返回的通知 id") },
      handler: async (args, context) => {
        try {
          const { notificationId } = z.object({ notificationId: z.number().int().min(1) }).parse(args);
          return ok(cancelProfileNotificationDelivery(context ?? requireProfileContext(), notificationId));
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    },
    {
      name: "quiet_hours",
      description: "查看或设置当前 Profile 的主动投递静默时段（窗口内 scheduler 不投递主动通知，窗口结束后自动补投；notify.pull 不受影响）。无参数为查看；传 start/end 设置（支持跨午夜，如 22:00–07:00）；clear=true 清除。静默时段只影响之后的投递。",
      schema: {
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("静默开始本地时间 HH:mm"),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("静默结束本地时间 HH:mm"),
        timezone: z.string().optional().describe("IANA 时区，缺省用 LIFE_ASSISTANT_TIMEZONE"),
        clear: z.boolean().optional().describe("true 时清除静默时段"),
      },
      handler: async (args, context) => {
        try {
          const profile = context ?? requireProfileContext();
          const parsed = z.object({
            start: z.string().optional(),
            end: z.string().optional(),
            timezone: z.string().optional(),
            clear: z.boolean().optional(),
          }).parse(args ?? {});
          if (parsed.clear) {
            return ok({ status: "cleared", quietHours: null, cleared: clearQuietHours(profile.id) });
          }
          if (parsed.start !== undefined || parsed.end !== undefined) {
            if (!isValidTimeOfDay(parsed.start) || !isValidTimeOfDay(parsed.end)) {
              return fail("设置静默时段需要同时提供合法的 start 与 end（HH:mm）");
            }
            return ok({ status: "saved", quietHours: saveQuietHours(profile.id, parsed.start!, parsed.end!, parsed.timezone) });
          }
          return ok({ status: "current", quietHours: getQuietHours(profile.id) });
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    },
  ],
};

registerModule(notifyModule);
