import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type duckdb from "duckdb";
import type { EvidenceMetadata } from "./types.js";

export const SQL_TIMEOUT_MS = 2_000;
export const SQL_MATERIALIZATION_BYTES = 1024 * 1024;

/** Deadline includes subprocess startup, ingestion, native execution and IPC.
 * Resolve/reject only after close: no analysis child survives a completed call.
 * 256MB is DuckDB's managed memory budget, NOT a total process RSS limit.
 */
export async function analyzeSql(metadata: EvidenceMetadata, sql?: string): Promise<{ rows: duckdb.TableData; count?: number }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-flow-sql-"));
  try {
    return await new Promise((resolve, reject) => {
      const child = fork(new URL("./sql-worker.mjs", import.meta.url), [], {
        execArgv: ["--max-old-space-size=128"], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
      });
      let response: { rows: duckdb.TableData; count?: number; error?: string } | undefined;
      let failure: Error | undefined;
      const timer = setTimeout(() => { failure = new Error(`SQL exceeded its ${SQL_TIMEOUT_MS}ms analysis timeout (including setup/materialization).`); child.kill("SIGKILL"); }, SQL_TIMEOUT_MS);
      child.once("error", (error) => { failure = error; child.kill("SIGKILL"); });
      child.once("message", (message) => {
        response = message as typeof response;
        child.kill("SIGKILL");
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (response?.error) reject(new Error(response.error));
        else if (response) resolve(response);
        else reject(new Error(`SQL analysis process exited without a result (${signal ?? code}).`));
      });
      child.send({ metadata, sql, directory, maxRows: 201, maxBytes: SQL_MATERIALIZATION_BYTES });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
