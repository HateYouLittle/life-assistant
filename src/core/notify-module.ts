import { ok, registerModule, type AssistantModule } from "./registry.js";
import { pullPending } from "./notifier.js";
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
  ],
};

registerModule(notifyModule);
