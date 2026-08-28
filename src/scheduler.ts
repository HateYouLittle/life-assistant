/** Scheduler entry point: leases the singleton slot, registers module crons/ticks, and drains the outbox. It never serves MCP tools. */
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron, { type ScheduledTask } from "node-cron";
import { getModules } from "./modules/index.js";
import { getDatabase } from "./core/database.js";
import { deliverPendingProfileNotifications, notify, type DeliverySummary } from "./core/notifier.js";
import { notifyModule } from "./core/notify-module.js";

export { notifyModule };

const LEASE_NAME = "scheduler";
const LEASE_TTL_MS = 2 * 60 * 1000;

export function acquireSchedulerLease(owner: string, at = new Date()): boolean {
  const db = getDatabase();
  const timestamp = at.toISOString();
  db.prepare("INSERT OR IGNORE INTO scheduler_lease(name, owner, acquired_at) VALUES(?, ?, ?)").run(LEASE_NAME, owner, timestamp);
  const row = db.prepare("SELECT owner, acquired_at FROM scheduler_lease WHERE name = ?").get(LEASE_NAME) as { owner: string; acquired_at: string } | undefined;
  if (!row) return false;
  if (row.owner === owner) {
    const result = db.prepare("UPDATE scheduler_lease SET acquired_at = ? WHERE name = ? AND owner = ?").run(timestamp, LEASE_NAME, owner) as { changes: number };
    return result.changes === 1;
  }
  const age = at.getTime() - Date.parse(row.acquired_at);
  if (age > LEASE_TTL_MS) {
    const result = db.prepare("UPDATE scheduler_lease SET owner = ?, acquired_at = ? WHERE name = ? AND owner = ? AND acquired_at = ?").run(owner, timestamp, LEASE_NAME, row.owner, row.acquired_at) as { changes: number };
    return result.changes === 1;
  }
  return false;
}

export function refreshSchedulerLease(owner: string, at = new Date()): boolean {
  const result = getDatabase().prepare(
    "UPDATE scheduler_lease SET acquired_at = ? WHERE name = ? AND owner = ?",
  ).run(at.toISOString(), LEASE_NAME, owner) as { changes: number };
  return result.changes === 1;
}

export function releaseSchedulerLease(owner: string): void {
  getDatabase().prepare("DELETE FROM scheduler_lease WHERE name = ? AND owner = ?").run(LEASE_NAME, owner);
}

export async function runSchedulerTick(at = new Date(), fetchImpl: typeof fetch = fetch): Promise<DeliverySummary> {
  const errors: unknown[] = [];
  for (const module of getModules()) {
    if (!module.tick) continue;
    try {
      await module.tick(at);
    } catch (error) {
      errors.push(error);
    }
  }
  // 投递在所有模块扫描之后统一执行；扫描失败不阻断在途投递排空，
  // 汇总错误在投递后抛出（与既有"先扫后投、错后抛"语义一致）。
  let summary: DeliverySummary;
  try {
    summary = await deliverPendingProfileNotifications({ at, fetchImpl });
  } catch (error) {
    // L4：投递异常加入 errors 一并聚合上报，不得让投递抛错吞掉已收集的模块 tick 错误。
    errors.push(error);
    summary = { attempted: 0, sent: 0, failed: 0 };
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} module ticks failed`);
  return summary;
}

export interface SchedulerHandle {
  stop(): void;
  owner: string;
  started: boolean;
}

export function startScheduler(): SchedulerHandle {
  const owner = `${process.pid}-${crypto.randomUUID()}`;
  if (!acquireSchedulerLease(owner)) return { owner, started: false, stop: () => undefined };
  const tasks: ScheduledTask[] = [];
  let stopped = false;
  let activeRuns = 0;
  let leaseReleased = false;
  let heartbeat: NodeJS.Timeout;
  const releaseIfIdle = (): void => {
    if (!stopped || activeRuns !== 0 || leaseReleased) return;
    releaseSchedulerLease(owner);
    leaseReleased = true;
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    for (const task of tasks) task.stop();
    releaseIfIdle();
  };
  const fence = (): boolean => {
    if (stopped) return false;
    try {
      if (refreshSchedulerLease(owner)) return true;
    } catch (error) {
      // M7：续租写锁失败（如 SQLITE_BUSY）是瞬态错误，不等于租约丢失——
      // 吞掉并记日志，绝不从 setInterval 心跳未捕获冒泡终止进程。
      console.error("[scheduler] lease refresh failed:", error);
      return false;
    }
    console.error("[scheduler] lease lost; stopping all scheduled work");
    stop();
    return false;
  };
  const runFenced = async (handler: () => Promise<void>): Promise<void> => {
    if (!fence()) return;
    activeRuns += 1;
    try {
      await handler();
    } finally {
      activeRuns -= 1;
      releaseIfIdle();
    }
  };
  heartbeat = setInterval(() => {
    try {
      fence();
    } catch (error) {
      // M7：fence 内部已兜住续租抛错；此处兜底防止未来心跳回调改动引入未捕获异常。
      console.error("[scheduler] heartbeat failed:", error);
    }
  }, 60_000);
  heartbeat.unref();
  for (const module of getModules()) {
    if (!module.onStart) continue;
    // 启动引导：不阻塞 startScheduler 返回，异常只记日志，不影响其余模块与后续 job。
    void runFenced(async () => {
      try {
        await module.onStart!();
      } catch (error) {
        console.error(`[startup ${module.name}] failed:`, error);
      }
    });
  }
  for (const module of getModules()) {
    for (const job of module.jobs ?? []) {
      const task = cron.schedule(job.cron, async () => {
        await runFenced(async () => {
          try {
            await job.handler({ notify });
          } catch (error) {
            console.error(`[job ${module.name}.${job.name}] failed:`, error);
          }
        });
      }, job.timezone ? { timezone: job.timezone } : undefined);
      tasks.push(task);
      console.log(`[scheduler] registered ${module.name}.${job.name} cron="${job.cron}"`);
    }
  }
  let tickRunning = false;
  tasks.push(cron.schedule("* * * * *", async () => {
    // L24：投递有界——最多 5 worker、45s 预算（见 notify-delivery），远短于 tick 周期；
    // 跳过重叠 tick 避免故障期负载放大。
    if (tickRunning) return;
    tickRunning = true;
    try {
      await runFenced(async () => {
        try {
          await runSchedulerTick();
        } catch (error) {
          console.error("[scheduler.tick] failed:", error);
        }
      });
    } finally {
      tickRunning = false;
    }
  }));
  console.log(`[scheduler] started, ${tasks.length} jobs from ${getModules().length} modules.`);
  return {
    owner,
    started: true,
    stop,
  };
}

async function main(): Promise<void> {
  const handle = startScheduler();
  if (!handle.started) {
    console.error("[scheduler] lease not acquired: another scheduler owns this DATA_DIR; exiting (retry after lease TTL).");
    process.exitCode = 1;
    return;
  }
  const shutdown = (): void => {
    handle.stop();
    process.exitCode = 0;
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main();
}
