import { config, resolveRenderTarget } from "../config.js";
import { publishGlobal, publishProfile, type GlobalPublishFn, type ProfilePublishFn } from "./notifier.js";
import {
  renderNotification,
  type NotificationEnvelope,
  type NotificationRenderer,
  type NotificationRenderTarget,
} from "./notification.js";

export interface NotificationPublishers {
  publishGlobal?: GlobalPublishFn;
  publishProfile?: ProfilePublishFn;
  renderTarget?: NotificationRenderTarget;
  /** 按 Profile 求渲染目标；返回 undefined 时继续回退到 renderTarget / 配置 / plain。 */
  renderTargetForProfile?: (profileId: string) => NotificationRenderTarget | undefined;
  renderer?: NotificationRenderer;
}

/** 解析单个 Profile 的渲染目标：注入回调 > 共享 renderTarget > 配置 renderTarget（resolveRenderTarget 恒回退 plain）。 */
function resolveTargetForProfile(publishers: NotificationPublishers, profileId: string): NotificationRenderTarget {
  return publishers.renderTargetForProfile?.(profileId)
    ?? publishers.renderTarget
    ?? resolveRenderTarget(config.profilePushRoutes[profileId]);
}

/**
 * 把一条业务信封接入通知引擎：
 * - 渲染发生在发布方进程：共享渲染作为 fan-out 的 title/body 契约入参，
 *   每 Profile 落库快照由 renderForProfile 回调按各自 target 独立生成；
 * - 信封随快照一并落库（envelope 列），供投递期钩子重渲染；
 * - 迁移兼容键读取信封上的 legacyDedupeKeys（模块构造时附带），发布层无额外参数。
 */
export async function publishNotification(
  notification: NotificationEnvelope,
  publishers: NotificationPublishers = {},
): Promise<void> {
  const dedupeKey = `${notification.source}:${notification.identity}`;
  if (notification.scope.type === "global") {
    // 共享渲染作为 publishGlobal 的 title/body 契约入参；每个 Profile 的落库
    // 快照由 renderForProfile 回调按该 Profile 的 target 独立渲染（fan-out 内生效）。
    const shared = (publishers.renderer ?? renderNotification)(notification, publishers.renderTarget);
    const renderForProfile = (profileId: string): { title: string; body: string } =>
      (publishers.renderer ?? renderNotification)(notification, resolveTargetForProfile(publishers, profileId));
    await (publishers.publishGlobal ?? publishGlobal)(
      {
        source: notification.source,
        title: shared.title,
        body: shared.body,
        dedupeKey,
      },
      {
        legacyDedupeKeys: notification.legacyDedupeKeys,
        renderForProfile,
      },
    );
    return;
  }
  const profileId = notification.scope.profileId;
  const rendered = (publishers.renderer ?? renderNotification)(notification, resolveTargetForProfile(publishers, profileId));
  // envelope 随快照一并落库：schedule.reminder 在投递时据此重算相对时间（delivery-render）。
  await (publishers.publishProfile ?? publishProfile)(
    {
      profileId,
      source: notification.source,
      title: rendered.title,
      body: rendered.body,
      dedupeKey,
      envelope: notification,
    },
  );
}
