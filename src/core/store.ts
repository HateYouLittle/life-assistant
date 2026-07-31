import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * JSON 文件存储。接口刻意保持 get/set/del 三个原子操作，
 * 后续可平替 SQLite / Redis 而不动业务代码。
 */
class Store {
  private file: string;
  private cache: Record<string, unknown> | null = null;

  constructor() {
    this.file = path.join(config.dataDir, "store.json");
  }

  private load(): Record<string, unknown> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
    fs.renameSync(tmp, this.file); // 原子替换，避免写一半损坏
  }

  get<T>(key: string, fallback?: T): T | undefined {
    const v = this.load()[key];
    return (v === undefined ? fallback : (v as T)) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.load()[key] = value;
    this.persist();
  }

  del(key: string): void {
    delete this.load()[key];
    this.persist();
  }
}

export const store = new Store();
