import { config } from "../config.js";
import { store } from "./store.js";
import { httpJson } from "./http.js";

export interface Notice {
  id: number; // 自增 ID，用于多消费者已读追踪
  title: string;
  body: string;
  time: string;
  dedupeKey?: string;
}

interface Channel {
  name: string;
  send: (n: Notice) => Promise<void>;
}

/** 通知通道适配器：新增通道（钉钉/飞书/邮件…）只需往数组里加一项 */
const channels: Channel[] = [
  {
    name: "stdout",
    send: async (n) => {
      console.log(`\n[NOTIFY ${n.time}] ${n.title}\n${n.body}\n`);
    },
  },
  ...(config.notify.webhookUrl
    ? [{
        name: "webhook",
        send: async (n: Notice) => {
          await httpJson(config.notify.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(n),
          });
        },
      } as Channel]
    : []),
  ...(config.notify.barkUrl
    ? [{
        name: "bark",
        send: async (n: Notice) => {
          const url = `${config.notify.barkUrl.replace(/\/$/, "")}/${encodeURIComponent(n.title)}/${encodeURIComponent(n.body)}`;
          await httpJson(url);
        },
      } as Channel]
    : []),
  ...(config.notify.serverchanSendKey
    ? [{
        name: "serverchan",
        send: async (n: Notice) => {
          await httpJson(`https://sctapi.ftqq.com/${config.notify.serverchanSendKey}.send`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `title=${encodeURIComponent(n.title)}&desp=${encodeURIComponent(n.body)}`,
          });
        },
      } as Channel]
    : []),
];

const DEDUPE_KEY = "notify:sent_keys";
const SEQ_KEY = "notify:seq";

/** 生成自增通知 ID（跨进程共享 store.json，多消费者靠它去重） */
function nextId(): number {
  const seq = store.get<number>(SEQ_KEY, 0)!;
  store.set(SEQ_KEY, seq + 1);
  return seq + 1;
}

/** 扇出通知：推送全部通道 + 写入待读队列（供 notify.pull 兜底），带去重 */
export async function notify(title: string, body: string, dedupeKey?: string): Promise<void> {
  if (dedupeKey) {
    const sent = store.get<string[]>(DEDUPE_KEY, [])!;
    if (sent.includes(dedupeKey)) return;
    store.set(DEDUPE_KEY, [...sent.slice(-500), dedupeKey]);
  }

  const notice: Notice = { id: nextId(), title, body, time: new Date().toISOString(), dedupeKey };

  // 入待读队列（上限 100 条）
  const queue = store.get<Notice[]>("pending_notifications", [])!;
  store.set("pending_notifications", [...queue, notice].slice(-100));

  // 扇出到各通道，单通道失败不影响其他通道
  await Promise.allSettled(channels.map((c) => c.send(notice)));
}

/**
 * 取走未读通知（notify.pull 工具使用）。
 * - 传入 consumer（如 profile 名）：只返回该消费者未读的通知，并记录已读 id（队列不清空，多消费者共享）
 * - 不传 consumer：保持旧行为，清空整个队列（向后兼容）
 */
export function pullPending(consumer?: string): Notice[] {
  const queue = store.get<Notice[]>("pending_notifications", [])!;
  if (!consumer) {
    store.set("pending_notifications", []);
    return queue;
  }
  const readKey = `notify:read:${consumer}`;
  const readIds = store.get<number[]>(readKey, [])!;
  const unseen = queue.filter((n) => !readIds.includes(n.id));
  store.set(readKey, [...readIds.slice(-500), ...unseen.map((n) => n.id)]);
  return unseen;
}
