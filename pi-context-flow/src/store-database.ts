import { fork } from "node:child_process";
import type duckdb from "duckdb";
import { withStoreLock } from "./store-lock.js";

export async function storeDatabase(path: string, kind: "exec" | "all" | "run", sql: string, values: unknown[] = []): Promise<duckdb.TableData> {
  return withStoreLock(`${path}.lock`, () => new Promise((resolve, reject) => {
    const child = fork(new URL("./store-worker.mjs", import.meta.url), [], {
      execArgv: [], env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    });
    let response: { rows?: duckdb.TableData; error?: string } | undefined;
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Context Flow database operation exceeded 10000ms; completion may be uncertain."); child.kill("SIGKILL"); }, 10_000);
    child.once("error", (error) => { failure = error; child.kill("SIGKILL"); });
    child.once("message", (message) => { response = message as typeof response; });
    // Never release the lock on message: native handles survive until the child exits.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (response?.error) reject(new Error(response.error));
      else if (code !== 0 || !response) reject(new Error(`Context Flow database process exited without success (${signal ?? code}).`));
      else resolve(response.rows ?? []);
    });
    child.send({ path, kind, sql, values }, (error) => { if (error) { failure = error; child.kill("SIGKILL"); } });
  }));
}
