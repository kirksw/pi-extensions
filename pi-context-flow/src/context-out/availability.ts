import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ContextOutIdentity } from "./identity.js";
import type { ContextOutEvent } from "./events.js";

export type EvidenceSnapshot = { evidenceId: string; sha256: string; sizeBytes: number; shape: string; coverage: string; workspaceRelative?: string };
export type Assessment = { reference: string; status: "available" | "unavailable" | "unverified"; reason: string; coverage: string; assessedAt: string };
export function supportCoverage(items: Assessment[]) {
  const counts = { available: 0, unavailable: 0, unverified: 0 };
  for (const item of items) counts[item.status]++;
  const status = !items.length ? "unsupported" : counts.available === items.length ? "available"
    : counts.unavailable === items.length ? "unavailable" : counts.unverified === items.length ? "unverified" : "partial";
  return { status, counts };
}
/** Fixed local raw filenames only. Never follow a raw path supplied by an event or another origin. */
export async function assessEvidence(identity: ContextOutIdentity, origin: ContextOutEvent["origin"], snapshots: EvidenceSnapshot[]): Promise<Assessment[]> {
  const deadline = Date.now() + 2000;
  let budget = 8 * 1024 * 1024;
  const same = origin.cloneId === identity.cloneId && origin.worktreeId === identity.worktreeId;
  let originMissing = false;
  if (!same) {
    try { originMissing = !(await lstat(origin.worktreeRoot)).isDirectory(); }
    catch (e) { originMissing = (e as NodeJS.ErrnoException).code === "ENOENT"; }
  }
  const results: Assessment[] = [];
  for (const snapshot of snapshots) {
    const item: Assessment = { reference: `evidence://${snapshot.evidenceId}`, status: "unverified", reason: "Inspection budget exceeded", coverage: snapshot.coverage, assessedAt: new Date().toISOString() };
    results.push(item);
    if (!same) { item.status = originMissing ? "unavailable" : "unverified"; item.reason = originMissing ? "Origin directory is missing" : "Cross-origin inspection is not supported"; continue; }
    if (!/^[a-zA-Z0-9_-]+$/.test(snapshot.evidenceId) || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) { item.reason = "Invalid snapshot identity/hash"; continue; }
    if (Date.now() >= deadline || snapshot.sizeBytes > budget) continue;
    try {
      const workspace = snapshot.workspaceRelative ?? "";
      if (!safeWorkspaceRelative(workspace)) throw new Error("Unsafe workspace locator");
      const path = join(identity.worktreeRoot, workspace, ".pi", "context", "evidence", "raw", `${snapshot.evidenceId}.${snapshot.shape === "json" ? "json" : "txt"}`);
      const rel = relative(await realpath(identity.worktreeRoot), await realpath(path));
      if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Unsafe raw locator");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("Not regular evidence");
        if (stat.size !== snapshot.sizeBytes) { item.status = "unavailable"; item.reason = "Integrity failure: size mismatch"; continue; }
        const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let size = 0;
        while (size < snapshot.sizeBytes) {
          if (Date.now() >= deadline || budget <= 0) throw new Error("Inspection budget exceeded");
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, budget, snapshot.sizeBytes - size), null);
          if (!bytesRead) break;
          budget -= bytesRead; size += bytesRead; hash.update(buffer.subarray(0, bytesRead));
        }
        const matches = size === snapshot.sizeBytes && hash.digest("hex") === snapshot.sha256;
        item.status = matches ? "available" : "unavailable"; item.reason = matches ? "Matching raw content verified; coverage is independent" : "Integrity failure: hash mismatch";
      } finally { await file.close(); }
    } catch (e) {
      item.status = (e as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "unverified";
      item.reason = item.status === "unavailable" ? "Raw evidence missing" : "Inspection failed or exceeded budget";
    }
  }
  return results;
}

export function safeWorkspaceRelative(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\\") && !value.includes("\0")
    && (value === "" || value.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && !part.includes(":")));
}
