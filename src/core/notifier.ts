/**
 * 通知引擎门面。
 *
 * 实现分三层，各自独立成文件；既有调用方仍统一从这里导入：
 * - notify-publish.ts ：发布去重落库（含 legacy dedupe key 迁移的唯一实现）
 * - notify-delivery.ts：outbox 投递状态机（claim/HMAC 发送/幂等窗口/route 漂移恢复）
 * - notify-manage.ts  ：用户操作（pull/list/snooze/cancel）
 */
export {
  publishGlobal,
  publishProfile,
  notify,
  type PublishGlobalInput,
  type PublishProfileInput,
  type GlobalPublishFn,
  type ProfilePublishFn,
} from "./notify-publish.js";
export { deliverPendingProfileNotifications, type DeliverySummary } from "./notify-delivery.js";
export {
  pullPending,
  listProfileNotifications,
  snoozeProfileNotificationDelivery,
  cancelProfileNotificationDelivery,
  type Notice,
  type SnoozeSummary,
  type CancelSummary,
  type NotificationListEntry,
  type NotificationDeliveryView,
} from "./notify-manage.js";
