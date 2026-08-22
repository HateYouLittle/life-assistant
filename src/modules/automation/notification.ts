import type { NotificationEnvelope } from "../../core/notification.js";
import type { AutomationItem } from "./types.js";

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
}): NotificationEnvelope {
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
