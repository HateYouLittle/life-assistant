export type AutomationConditionOp = ">" | ">=" | "<" | "<=" | "==" | "!=";

/** 条件 DSL：对 action 结果按 dot-path 取值比较；字段缺失视为不满足。 */
export interface AutomationCondition {
  field: string;
  op: AutomationConditionOp;
  value: number | string;
}

export type AutomationSchedule =
  | { type: "daily"; time: string; timezone: string }
  | { type: "interval"; minutes: number };

export interface AutomationItem {
  id: string;
  profileId: string;
  name: string;
  action: string;
  params: Record<string, unknown>;
  condition?: AutomationCondition;
  schedule: AutomationSchedule;
  enabled: boolean;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationListOptions {
  enabled?: boolean;
}
