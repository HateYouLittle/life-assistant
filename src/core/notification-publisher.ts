import { config, resolveRenderTarget } from "../config.js";
import { publishGlobal, publishProfile } from "./notifier.js";
import {
  renderNotification,
  type NotificationEnvelope,
  type NotificationRenderer,
  type NotificationRenderTarget,
} from "./notification.js";

type GlobalPublisher = (
  source: string,
  title: string,
  body: string,
  dedupeKey: string,
  legacyDedupeKeys?: readonly string[],
  options?: { renderForProfile?: (profileId: string, shared: { title: string; body: string }) => { title: string; body: string } },
) => Promise<void>;
type ProfilePublisher = (
  profileId: string,
  source: string,
  title: string,
  body: string,
  dedupeKey: string,
  legacyDedupeKeys?: readonly string[],
  envelope?: NotificationEnvelope,
) => Promise<void>;

export interface NotificationPublishers {
  publishGlobal?: GlobalPublisher;
  publishProfile?: ProfilePublisher;
  renderTarget?: NotificationRenderTarget;
  /** 按 Profile 求渲染目标；返回 undefined 时继续回退到 renderTarget / 配置 / plain。 */
  renderTargetForProfile?: (profileId: string) => NotificationRenderTarget | undefined;
  renderer?: NotificationRenderer;
}

/** 解析单个 Profile 的渲染目标：注入回调 > 共享 renderTarget > 配置 renderTarget > plain。 */
function resolveTargetForProfile(publishers: NotificationPublishers, profileId: string): NotificationRenderTarget {
  return publishers.renderTargetForProfile?.(profileId)
    ?? publishers.renderTarget
    ?? resolveRenderTarget(config.profilePushRoutes[profileId])
    ?? "plain";
}

export async function publishNotification(
  notification: NotificationEnvelope,
  publishers: NotificationPublishers = {},
  legacyDedupeKeys: readonly string[] = [],
): Promise<void> {
  const dedupeKey = `${notification.source}:${notification.identity}`;
  if (notification.scope.type === "global") {
    // 共享渲染作为 publishGlobal 的 title/body 契约入参；每个 Profile 的落库
    // 快照由 renderForProfile 回调按该 Profile 的 target 独立渲染（fan-out 内生效）。
    const shared = (publishers.renderer ?? renderNotification)(notification, publishers.renderTarget);
    const renderForProfile = (profileId: string): { title: string; body: string } =>
      (publishers.renderer ?? renderNotification)(notification, resolveTargetForProfile(publishers, profileId));
    await (publishers.publishGlobal ?? publishGlobal)(
      notification.source,
      shared.title,
      shared.body,
      dedupeKey,
      legacyDedupeKeys,
      { renderForProfile },
    );
    return;
  }
  const profileId = notification.scope.profileId;
  const rendered = (publishers.renderer ?? renderNotification)(notification, resolveTargetForProfile(publishers, profileId));
  // envelope 随快照一并落库：schedule.reminder 在投递时据此重算相对时间（delivery-render）。
  await (publishers.publishProfile ?? publishProfile)(
    profileId,
    notification.source,
    rendered.title,
    rendered.body,
    dedupeKey,
    legacyDedupeKeys,
    notification,
  );
}
