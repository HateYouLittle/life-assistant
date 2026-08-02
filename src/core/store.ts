import { getDatabase } from "./database.js";

/** Compatibility key/value facade backed by the shared SQLite transaction store. */
class Store {
  get<T>(key: string, fallback?: T): T | undefined {
    const row = getDatabase().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    getDatabase().prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  del(key: string): void {
    getDatabase().prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
}

export const store = new Store();
