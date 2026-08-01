/**
 * 常驻调度进程：运行所有模块注册的定时任务，产生主动通知。
 * 部署：pm2 start dist/scheduler.js / systemd / docker
 */
import cron from "node-cron";
import { getModules } from "./modules/index.js";
import { notify, pullPending } from "./core/notifier.js";
import { registerModule, ok, type AssistantModule } from "./core/registry.js";

// 内建：notify.pull 工具也注册为一个模块，供 MCP Server 复用
export const notifyModule: AssistantModule = {
  name: "notify",
  tools: [
    {
      name: "pull",
      description:
        "拉取所有未读的主动通知（天气预警、油价预通知、快递动态）。建议每次会话开始时调用一次，确保用户不错过预警。",
      schema: {},
      handler: async () => {
        // 多消费者支持：MCP 进程由哪个 Hermes profile 拉起，就用哪个 profile 名做已读标记
        const consumer = process.env.HERMES_PROFILE || "default";
        const items = pullPending(consumer);
        return ok({ count: items.length, notifications: items });
      },
    },
  ],
};
registerModule(notifyModule);

async function main(): Promise<void> {
  const modules = getModules();
  let jobCount = 0;
  for (const m of modules) {
    for (const j of m.jobs ?? []) {
      cron.schedule(j.cron, async () => {
        try {
          await j.handler({ notify });
        } catch (e) {
          console.error(`[job ${m.name}.${j.name}] failed:`, e);
        }
      });
      jobCount++;
      console.log(`[scheduler] registered ${m.name}.${j.name}  cron="${j.cron}"`);
    }
  }
  console.log(`[scheduler] started, ${jobCount} jobs from ${modules.length} modules.`);
}

void main();
