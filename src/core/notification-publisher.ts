import { publishGlobal, publishProfile } from "./notifier.js";
import { renderNotification, type NotificationEnvelope } from "./notification.js";

type GlobalPublisher = (
  source: string,
  title: string,
  body: string,
  dedupeKey: string,
  legacyDedupeKeys?: readonly string[],
) => Promise<void>;
type ProfilePublisher = (
  profileId: string,
  source: string,
  title: string,
  body: string,
  dedupeKey: string,
  legacyDedupeKeys?: readonly string[],
) => Promise<void>;

export interface NotificationPublishers {
  publishGlobal?: GlobalPublisher;
  publishProfile?: ProfilePublisher;
}

export async function publishNotification(
  notification: NotificationEnvelope,
  publishers: NotificationPublishers = {},
  legacyDedupeKeys: readonly string[] = [],
): Promise<void> {
  const rendered = renderNotification(notification);
  const dedupeKey = `${notification.source}:${notification.identity}`;
  if (notification.scope.type === "global") {
    await (publishers.publishGlobal ?? publishGlobal)(
      notification.source,
      rendered.title,
      rendered.body,
      dedupeKey,
      legacyDedupeKeys,
    );
    return;
  }
  await (publishers.publishProfile ?? publishProfile)(
    notification.scope.profileId,
    notification.source,
    rendered.title,
    rendered.body,
    dedupeKey,
    legacyDedupeKeys,
  );
}
