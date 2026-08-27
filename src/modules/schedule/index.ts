import { z } from "zod";
import { registerModule, ok, withTool, type AssistantModule } from "../../core/registry.js";
import { requireProfileContext } from "../../core/profile.js";
import {
  completeSchedule,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
} from "./service.js";

const reminderSchema = z.object({
  id: z.string().optional(),
  minutesBefore: z.number().int().min(0).max(525600),
  target: z.enum(["occurrence", "deadline"]).optional(),
});

const recurrenceSchema = z.union([
  z.enum(["once", "daily", "weekly", "monthly", "yearly", "workday", "holiday"]),
  z.object({
    frequency: z.enum(["once", "daily", "weekly", "monthly", "yearly", "workday", "holiday"]).optional(),
    interval: z.number().int().min(1).optional(),
    byWeekday: z.array(z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])).optional(),
    byMonthDay: z.number().int().min(1).max(31).optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD").optional(),
    count: z.number().int().min(1).optional(),
  }),
]);

const commonFields = {
  type: z.enum(["todo", "birthday", "anniversary"]).optional(),
  title: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  status: z.enum(["active", "completed", "archived"]).optional(),
  calendar: z.enum(["solar", "lunar"]).default("solar"),
  date: z.string().optional(),
  time: z.string().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  lunarMonth: z.number().int().min(1).max(12).optional(),
  lunarDay: z.number().int().min(1).max(30).optional(),
  isLeapMonth: z.boolean().optional(),
  leapMonthPolicy: z.enum(["normal", "leap"]).optional(),
  recurrence: recurrenceSchema.optional(),
  reminders: z.array(reminderSchema).optional(),
  deadlineAt: z.string().optional(),
  deadlineOffsetMinutes: z.number().int().min(0).max(525600).optional(),
  clearDeadline: z.boolean().optional(),
};

const updateFields = {
  type: z.enum(["todo", "birthday", "anniversary"]).optional(),
  title: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  status: z.enum(["active", "completed", "archived"]).optional(),
  calendar: z.enum(["solar", "lunar"]).optional(),
  date: z.string().optional(),
  time: z.string().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  lunarMonth: z.number().int().min(1).max(12).optional(),
  lunarDay: z.number().int().min(1).max(30).optional(),
  isLeapMonth: z.boolean().optional(),
  leapMonthPolicy: z.enum(["normal", "leap"]).optional(),
  recurrence: recurrenceSchema.optional(),
  reminders: z.array(reminderSchema).optional(),
  deadlineAt: z.string().optional(),
  deadlineOffsetMinutes: z.number().int().min(0).max(525600).optional(),
  clearDeadline: z.boolean().optional(),
};

const scheduleModule: AssistantModule = {
  name: "schedule",
  tools: [
    withTool(
      {
        name: "create",
        description: "在当前 Hermes Profile 中创建私有待办、生日或纪念日。支持公历和中国农历；农历日期必须使用 lunarMonth/lunarDay，不要当作公历日期填写。recurrence.frequency 支持 workday（中国大陆法定工作日：周一至周五剔除法定节假日、加入调休上班的周末）与 holiday（仅法定节假日休假日，不含普通周末），两者仅支持公历与 Asia/Shanghai 时区。",
      },
      commonFields,
      (args, context) => ok(createSchedule(context ?? requireProfileContext(), args)),
    ),
    withTool(
      {
        name: "list",
        description: "列出当前 Hermes Profile 的私有日程，可按类型、状态、时间范围和 upcoming 数量筛选。",
      },
      {
        type: z.enum(["todo", "birthday", "anniversary"]).optional(),
        status: z.enum(["active", "completed", "archived"]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        upcoming: z.number().int().min(1).max(500).optional(),
      },
      (args, context) => ok(listSchedules(context ?? requireProfileContext(), args)),
    ),
    withTool(
      { name: "get", description: "查看当前 Hermes Profile 的一条私有日程。" },
      { id: z.string() },
      (args, context) => ok(getSchedule(context ?? requireProfileContext(), args.id)),
    ),
    withTool(
      {
        name: "update",
        description: "修改当前 Hermes Profile 的私有日程；不能通过参数切换到其他 Profile。",
      },
      { id: z.string(), ...updateFields },
      (args, context) => {
        const { id, ...changes } = args;
        return ok(updateSchedule(context ?? requireProfileContext(), id, changes));
      },
    ),
    withTool(
      { name: "complete", description: "完成当前 Profile 的一次性日程或某个重复 occurrence。" },
      { id: z.string(), occurrenceKey: z.string().optional() },
      (args, context) => ok(completeSchedule(context ?? requireProfileContext(), args.id, args.occurrenceKey)),
    ),
    withTool(
      { name: "delete", description: "删除当前 Hermes Profile 的私有日程及其未投递提醒。" },
      { id: z.string() },
      (args, context) => {
        deleteSchedule(context ?? requireProfileContext(), args.id);
        return ok({ deleted: true, id: args.id });
      },
    ),
  ],
};

registerModule(scheduleModule);
