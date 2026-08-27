/**
 * 通知信封骨架与渲染管道（核心层不携带任何业务载荷）。
 *
 * 分工：
 * - 各模块在自己的 notification.ts 中定义 payload 结构、构造 Envelope，
 *   并通过 registerNotificationBlocks() 注册该 kind 的 RenderBlock[] 构造器；
 * - 本文件只保留：Envelope 骨架（identity/source/scope/headline/provenance/details）、
 *   RenderBlock[] 中间表示、plain / markdown 两种确定性投影。
 * 新增一种通知不再需要改动核心层，只需在模块内注册渲染器并加载该模块。
 */

export type NotificationScope =
  | { type: "global" }
  | { type: "profile"; profileId: string };

export interface NotificationProvenance {
  provider?: string;
  publisher?: string;
}

interface NotificationCore {
  identity: string;
  source: string;
  scope: NotificationScope;
  headline: string;
  generatedAt: string;
  provenance?: NotificationProvenance;
  details?: string;
  /** 迁移期兼容键（旧版本 dedupe key）：命中时改键复用旧行，避免升级当天重复推送。由模块在构造信封时附带。 */
  legacyDedupeKeys?: readonly string[];
}

/** 开放信封：kind/payload 由各业务模块通过 EnvelopeFor 收紧类型后构造。 */
export interface NotificationEnvelope extends NotificationCore {
  kind: string;
  payload: unknown;
}

/** 模块侧的类型收紧器：声明某 kind 的固定 payload 形状。 */
export interface EnvelopeFor<K extends string, P> extends NotificationCore {
  kind: K;
  payload: P;
}

export interface RenderedNotification {
  title: string;
  body: string;
}

export type NotificationRenderTarget =
  | "plain"
  | "qq-markdown"
  | "feishu-markdown"
  | "wechat-markdown";

export type NotificationRenderer = (
  notification: NotificationEnvelope,
  target?: NotificationRenderTarget,
) => RenderedNotification;

// ============================================================================
// 结构化块中间表示（RenderBlock[] IR）
//
// plain / qq-markdown / feishu-markdown / wechat-markdown 都是同一份 RenderBlock[]
// 的确定性投影：qq/feishu/wechat 三平台统一同一套保守 markdown 渲染规则，plain 为兜底。
// 官方原文（details 字段）一律走 raw 块：原样输出、永不被解析/转义。
// plain 投影必须与阶段 A 黄金样例逐字节一致（硬约束）。
// ============================================================================

export type RenderBlock =
  | { type: "line"; text: string }
  | { type: "label"; label: string; value: string; plainNoPrefix?: boolean }
  | { type: "section"; title?: string }
  | { type: "raw"; text: string };

/**
 * kind → RenderBlock[] 构造器注册表。各业务模块在 import 时自注册；
 * 同一 kind 重复注册视为编程错误（两次 import 不可能重复，防手写冲突）。
 */
type BlockRenderer = (notification: NotificationEnvelope) => RenderBlock[];

const blockRenderers = new Map<string, BlockRenderer>();

export function registerNotificationBlocks(kind: string, render: BlockRenderer): void {
  if (blockRenderers.has(kind)) {
    throw new Error(`duplicate notification block renderer for kind: ${kind}`);
  }
  blockRenderers.set(kind, render);
}

function fallbackBlocks(notification: NotificationEnvelope): RenderBlock[] {
  const blocks: RenderBlock[] = [{ type: "line", text: notification.headline }];
  if (notification.details) blocks.push({ type: "raw", text: notification.details });
  return blocks;
}

function renderBlocks(notification: NotificationEnvelope): RenderBlock[] {
  const render = blockRenderers.get(notification.kind);
  if (!render) return fallbackBlocks(notification);
  return render(notification);
}

// ---------------------------------------------------------------------------
// plain 投影：与阶段 A 黄金样例逐字节一致（join("\n") 语义，section → 空行）。
// ---------------------------------------------------------------------------

function blockToPlain(block: RenderBlock): string {
  switch (block.type) {
    case "line":
      return block.text;
    case "label":
      return block.plainNoPrefix ? block.value : `${block.label}：${block.value}`;
    case "section":
      return "";
    case "raw":
      return block.text;
  }
}

function renderPlainBlocks(blocks: RenderBlock[]): string {
  return blocks.map(blockToPlain).join("\n");
}

function renderPlainNotification(notification: NotificationEnvelope): RenderedNotification {
  return {
    title: notification.headline,
    body: renderPlainBlocks(renderBlocks(notification)),
  };
}

// ---------------------------------------------------------------------------
// markdown 投影：qq-markdown / feishu-markdown / wechat-markdown 三平台统一同一套保守渲染规则（D6）。
//   - 标题 → `# headline`（放进 title）；
//   - label 块 → `**标签**：值`；
//   - 块间空行（\n\n）；
//   - raw 块原样输出，不解析不转义（D7）；
//   - 省略与 headline 完全相同的首行（D2）。
// 禁止表格/列表/emoji/引用。
// ---------------------------------------------------------------------------

function blockToMarkdown(block: RenderBlock): string {
  switch (block.type) {
    case "line":
      return block.text;
    case "label":
      return `**${block.label}**：${block.value}`;
    case "section":
      return "";
    case "raw":
      return block.text;
  }
}

function renderMarkdownBlocks(blocks: RenderBlock[], headline: string): string {
  const parts: string[] = [];
  let isFirst = true;
  for (const block of blocks) {
    if (isFirst && block.type === "line" && block.text === headline) {
      isFirst = false;
      continue;
    }
    isFirst = false;
    if (block.type === "section") continue;
    parts.push(blockToMarkdown(block));
  }
  return parts.join("\n\n");
}

function renderMarkdownNotification(notification: NotificationEnvelope): RenderedNotification {
  return {
    title: `# ${notification.headline}`,
    body: renderMarkdownBlocks(renderBlocks(notification), notification.headline),
  };
}

export function renderNotification(
  notification: NotificationEnvelope,
  target: NotificationRenderTarget = "plain",
): RenderedNotification {
  if (target === "qq-markdown" || target === "feishu-markdown" || target === "wechat-markdown") {
    try {
      return renderMarkdownNotification(notification);
    } catch {
      // 平台分支任何异常都回退 plain 兜底，不允许 throw。
      return renderPlainNotification(notification);
    }
  }
  // plain | 未知/非法 target → plain 兜底投影。
  return renderPlainNotification(notification);
}
