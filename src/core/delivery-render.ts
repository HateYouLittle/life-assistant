import { getQuietHours, isQuietAt } from "./notification-settings.js";
import type { NotificationEnvelope } from "./notification.js";

/**
 * 投递/拉取时的快照重渲染（方案 A）。
 *
 * profile_notifications 落库的是发布时渲染好的文本快照；个别 kind 的快照里带
 * 相对发布时刻的内容（如 schedule.reminder 的"相对"行），勿扰顺延/重试/停机补发
 * 后推送会过期。核心层因此只提供"结构化 envelope 列存在则交给注册的模块钩子
 * 重渲染"的管道；schedule 模块在其 notification.ts 中注册自己的投递期钩子。
 * 未注册钩子（或存量无 envelope 行）维持"快照即投递"契约，原样输出。
 */

export interface DeliverySnapshotRow {
  profileId: string;
  title: string;
  body: string;
  /** 行级投递状态：not_before（snooze 设置）与 attempts（重试次数）。 */
  notBefore?: string | null;
  attempts?: number;
  /** 结构化快照 JSON；NULL 表示存量行，无重渲染能力。 */
  envelope?: string | null;
}

/** 判定推送顺延原因：snooze > 勿扰时段 > 投递重试（投递语义，非业务语义，留在核心层）。 */
export function deliveryDeferralReason(row: {
  profileId: string;
  /** 提醒的触发时刻（envelope 原始 payload.generatedAt）；判定勿扰顺延的依据。 */
  firedAt: string;
  notBefore?: string | null;
  attempts?: number;
}): string | undefined {
  if (row.notBefore) return "稍后提醒";
  try {
    // 用提醒触发时刻对照 Profile 当前静默配置；配置在顺延后被改动时只能按现值近似。
    const quiet = getQuietHours(row.profileId);
    if (quiet && isQuietAt(quiet, new Date(row.firedAt))) return "勿扰时段顺延";
  } catch {
    // Profile 已不在运行配置中时无从判定静默窗口，视为无原因。
  }
  if ((row.attempts ?? 0) > 0) return "投递重试延迟";
  return undefined;
}

/**
 * 模块投递期重渲染钩子：返回 null/undefined 或抛错均回退原快照；
 * 先注册者先尝试。
 */
export type DeliveryRerenderHook = (
  row: DeliverySnapshotRow,
  at: Date,
) => { title: string; body: string } | undefined | null;

const rerenderHooks: DeliveryRerenderHook[] = [];

export function registerDeliveryRerender(hook: DeliveryRerenderHook): void {
  rerenderHooks.push(hook);
}

/** 解析 envelope JSON；损坏行按无能力处理。 */
export function parseDeliveryEnvelope(row: DeliverySnapshotRow): NotificationEnvelope | null {
  if (!row.envelope) return null;
  try {
    const parsed = JSON.parse(row.envelope);
    if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") {
      return parsed as NotificationEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 按 at（投递/拉取时刻）重渲染：依次尝试已注册的模块钩子；任何异常回退原快照。
 */
export function renderDeliveredNotification(
  row: DeliverySnapshotRow,
  at: Date,
): { title: string; body: string } {
  for (const hook of rerenderHooks) {
    try {
      const rendered = hook(row, at);
      if (rendered) return rendered;
    } catch {
      // 单个钩子异常不阻断投递，继续回退。
    }
  }
  return { title: row.title, body: row.body };
}
