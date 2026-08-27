import {
  registerNotificationBlocks,
  type EnvelopeFor,
  type RenderBlock,
} from "../../core/notification.js";
import type { AutomationItem } from "./types.js";

// 载荷与渲染归本模块所有；core 只保留信封骨架与投影管道。

export interface AutomationResultPayload {
  name: string;
  action: string;
  schedule: string;
  timezone: string;
  condition?: { field: string; op: string; value: number | string };
  fields: Array<{ label: string; value: string }>;
}

export type AutomationResultEnvelope = EnvelopeFor<"automation.result", AutomationResultPayload>;

export function scheduleText(schedule: AutomationItem["schedule"]): string {
  return schedule.type === "daily"
    ? `每天 ${schedule.time}（${schedule.timezone}）`
    : `每 ${schedule.minutes} 分钟检查一次`;
}

/** 把 action 扁平结果压成通知展示字段：一层嵌套拍平为 dot 键，跳过更深结构与数组。 */
export function resultFields(result: Record<string, unknown>): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      if (Array.isArray(value)) continue;
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (childValue === undefined || childValue === null || typeof childValue === "object") continue;
        fields.push({ label: `${key}.${childKey}`, value: String(childValue) });
      }
      continue;
    }
    fields.push({ label: key, value: String(value) });
  }
  return fields.slice(0, 8);
}

export function automationResultNotification(input: {
  item: AutomationItem;
  fields: Array<{ label: string; value: string }>;
  identity: string;
  generatedAt: string;
  timezone: string;
}): AutomationResultEnvelope {
  const { item, fields } = input;
  return {
    kind: "automation.result",
    identity: input.identity,
    source: "automation",
    scope: { type: "profile", profileId: item.profileId },
    headline: `自动提醒 · ${item.name}`,
    generatedAt: input.generatedAt,
    payload: {
      name: item.name,
      action: item.action,
      schedule: scheduleText(item.schedule),
      timezone: input.timezone,
      condition: item.condition,
      fields,
    },
  };
}

// ---------------------------------------------------------------------------
// RenderBlock[] 构造器（自 core/notification.ts 下放，逻辑逐行保留）
// ---------------------------------------------------------------------------

const AUTOMATION_OP_LABEL: Record<string, string> = {
  ">": "大于",
  ">=": "大于等于",
  "<": "小于",
  "<=": "小于等于",
  "==": "等于",
  "!=": "不等于",
};

function automationResultBlocks(payload: AutomationResultPayload): RenderBlock[] {
  const blocks: RenderBlock[] = [
    { type: "line", text: `自动提醒 · ${payload.name}` },
  ];
  if (payload.condition) {
    const opLabel = AUTOMATION_OP_LABEL[payload.condition.op] ?? payload.condition.op;
    blocks.push({
      type: "label",
      label: "触发条件",
      value: `${payload.condition.field} ${opLabel} ${payload.condition.value}`,
    });
  }
  for (const field of payload.fields) {
    blocks.push({ type: "label", label: field.label, value: field.value });
  }
  blocks.push({ type: "label", label: "任务", value: `${payload.action}，${payload.schedule}` });
  return blocks;
}

registerNotificationBlocks("automation.result", (n) => automationResultBlocks(n.payload as AutomationResultPayload));
