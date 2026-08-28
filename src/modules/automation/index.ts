import { z } from "zod";
import { config } from "../../config.js";
import { registerModule, ok, withTool, type AssistantModule } from "../../core/registry.js";
import { requireProfileContext } from "../../core/profile.js";
import { automationActions } from "./actions.js";
import "./notification.js"; // 注册自动化结果渲染器（fan-out 渲染需要）
import {
  automationConditionSchema,
  automationScheduleSchema,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  runAutomationNow,
  runAutomationScan,
  updateAutomation,
} from "./service.js";

const actionHelp = Object.values(automationActions)
  .map((action) => `${action.name}：${action.description}`)
  .join("\n");

const scheduleField = automationScheduleSchema;

const conditionField = automationConditionSchema.optional().describe(
  "触发条件；缺省表示每次到点都提醒。field 是 action 结果的 dot-path（如 today.precipAmountMm、aqi、p92），数值比较，字段缺失视为不满足。注意 today.precipProb 仅 Open-Meteo 数据源有值，和风路径用 today.precipAmountMm；windSpeed 的单位随数据源不同（和风 km/h，Open-Meteo m/s）。",
);

export const automationModule: AssistantModule = {
  name: "automation",
  tools: [
    withTool(
      {
        name: "create",
        description: `创建当前 Profile 的私有自动任务（确定性执行，不使用 LLM）。scheduler 按 schedule 到点执行白名单 action，条件满足（或无条件）时通过主动通知提醒；同一任务每个本地日期最多主动提醒一次。可用 action：\n${actionHelp}`,
      },
      {
        name: z.string().min(1).max(100).describe("任务名，如 早晨下雨提醒"),
        action: z.string().describe("白名单 action 名，见工具说明"),
        params: z.record(z.string(), z.unknown()).optional().describe("action 参数，如 { city: \"北京\" } 或 { days: 2 }"),
        condition: conditionField,
        schedule: scheduleField.describe("daily（每天 time，可带 timezone）或 interval（每 minutes 分钟，最小 5）"),
        enabled: z.boolean().optional().describe("缺省 true"),
      },
      (args, context) => ok(createAutomation(context ?? requireProfileContext(), args)),
    ),
    withTool(
      {
        name: "list",
        description: "列出当前 Profile 的自动任务（含 enabled、调度、条件、最近一次运行结果与错误）。",
      },
      { enabled: z.boolean().optional().describe("按启用状态过滤") },
      (args, context) => ok({ automations: listAutomations(context ?? requireProfileContext(), args) }),
    ),
    withTool(
      {
        name: "update",
        description: "修改当前 Profile 的自动任务（name/action/params/condition/schedule/enabled）。condition 传 null 表示清除条件。",
      },
      {
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        action: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        condition: automationConditionSchema.nullable().optional(),
        schedule: automationScheduleSchema.optional(),
        enabled: z.boolean().optional(),
      },
      (args, context) => {
        const { id, ...changes } = args;
        return ok(updateAutomation(context ?? requireProfileContext(), id, changes));
      },
    ),
    withTool(
      { name: "delete", description: "删除当前 Profile 的自动任务。" },
      { id: z.string() },
      (args, context) => {
        deleteAutomation(context ?? requireProfileContext(), args.id);
        return ok({ deleted: true, id: args.id });
      },
    ),
    withTool(
      {
        name: "run",
        description: "立即手动执行一次自动任务并返回结果（用于验证配置）。条件满足时会推送一条提醒（同一本地日期内重复执行会去重，与 scheduler 扫描的每日去重语义一致）；手动执行不影响任务的既定调度节奏。",
      },
      { id: z.string() },
      (args, context) => ok(runAutomationNow(context ?? requireProfileContext(), args.id)),
    ),
  ],
  jobs: [
    {
      name: "scan",
      cron: config.cron.automationScan,
      handler: async () => {
        const outcomes = await runAutomationScan();
        if (outcomes.some((outcome) => outcome.error)) {
          // 单条失败已在 scan 内隔离记录，这里不抛出，避免阻断 scheduler 后续 job。
          console.error(`[automation] scan completed with ${outcomes.filter((o) => o.error).length} failure(s)`);
        }
      },
    },
  ],
};

registerModule(automationModule);
