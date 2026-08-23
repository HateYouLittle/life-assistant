import { config, resolveRenderTarget } from "../config.js";
import { getQuietHours, isQuietAt } from "./notification-settings.js";
import { renderNotification, type NotificationEnvelope } from "./notification.js";

/**
 * 投递/拉取时的快照重渲染（方案 A）。
 *
 * profile_notifications 落库的是发布时渲染好的文本快照；对 schedule.reminder，
 * 快照里的"相对"行以发布时刻计算，勿扰顺延/重试/停机补发后推送会带着过期的相对时间。
 * 因此发布时同步落一份结构化 envelope（v6 envelope 列），投递时按投递时刻重算相对时间，
 * 并在推送晚于提醒触发时刻时附加原因。其余 kind 维持"快照即投递"契约，原样输出。
 */

/** 投递参考时间的抖动容差：与 scheduler 发布参考时间的口径一致（60 秒）。 */
const DELIVERY_RENDER_TOLERANCE_MS = 60_000;

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

/** 判定推送顺延原因：snooze > 勿扰时段 > 投递重试。 */
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
 * 按 at（投递/拉取时刻）重渲染 schedule.reminder 快照：
 * 相对时间重算，亚分钟内的"逾期"钉回目标时刻（即时投递的抖动显示"现在"而非"已逾期 1 分钟"）；
 * 存在顺延原因时附加在相对行末尾。envelope 缺失/损坏/kind 不符/渲染异常一律回退原快照。
 */
export function renderDeliveredNotification(
  row: DeliverySnapshotRow,
  at: Date,
): { title: string; body: string } {
  const fallback = { title: row.title, body: row.body };
  if (!row.envelope) return fallback;
  let envelope: NotificationEnvelope;
  try {
    envelope = JSON.parse(row.envelope) as NotificationEnvelope;
  } catch {
    return fallback;
  }
  if (envelope?.kind !== "schedule.reminder") return fallback;
  const payload = envelope.payload;
  if (!payload.targetAt || !payload.generatedAt) return fallback;
  const targetMs = Date.parse(payload.targetAt);
  const firedAtMs = Date.parse(payload.generatedAt);
  if (!Number.isFinite(targetMs) || !Number.isFinite(firedAtMs)) return fallback;
  const nowMs = at.getTime();
  const referenceMs = nowMs >= targetMs && nowMs - targetMs <= DELIVERY_RENDER_TOLERANCE_MS
    ? targetMs
    : nowMs;
  const reference = new Date(referenceMs).toISOString();
  const reason = deliveryDeferralReason({
    profileId: row.profileId,
    firedAt: payload.generatedAt,
    notBefore: row.notBefore,
    attempts: row.attempts,
  });
  const reRendered: NotificationEnvelope = {
    ...envelope,
    generatedAt: reference,
    payload: {
      ...payload,
      generatedAt: reference,
      ...(reason ? { deferralReason: reason } : {}),
    },
  };
  try {
    const route = Object.prototype.hasOwnProperty.call(config.profilePushRoutes, row.profileId)
      ? config.profilePushRoutes[row.profileId]
      : undefined;
    return renderNotification(reRendered, resolveRenderTarget(route) ?? "plain");
  } catch {
    return fallback;
  }
}
