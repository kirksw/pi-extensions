import { open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";

export const STORE_LOCK_TIMEOUT_MS = 2000;
const queues = new Map<string, Promise<void>>();

export async function withStoreLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + STORE_LOCK_TIMEOUT_MS;
  const busy = () => new Error(`Context Flow store busy: ${path}. Wait for the other process; remove an abandoned lock only after confirming its recorded owner has stopped.`);
  const previous = queues.get(path) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = previous.then(() => current);
  queues.set(path, tail);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([previous, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(busy()), STORE_LOCK_TIMEOUT_MS); })]);
    clearTimeout(timer);
    let handle;
    for (;;) {
      if (performance.now() >= deadline) throw busy();
      try { handle = await open(path, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - performance.now()))));
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }) + "\n");
      return await operation();
    } finally {
      try { await handle.close(); } finally { await unlink(path); }
    }
  } finally {
    clearTimeout(timer);
    releaseQueue();
    // Keep the tail until preceding owners finish, including timed-out queued callers.
    void tail.then(() => { if (queues.get(path) === tail) queues.delete(path); });
  }
}
