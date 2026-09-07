import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContextStore } from "../store.js";
import type { Observation } from "../types.js";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { ContextOutEventInput, RevisionMetadata } from "./events.js";
import type { ContextOutIdentity } from "./identity.js";

const exec = promisify(execFile);
export async function originSnapshot(identity: ContextOutIdentity) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const run = async (...args: string[]) => {
    try { return (await exec("git", ["-C", identity.worktreeRoot, ...args], { env, timeout: 2000, maxBuffer: 64 * 1024 })).stdout.trim(); }
    catch { return null; }
  };
  const branch = await run("symbolic-ref", "--quiet", "--short", "HEAD");
  const revision = await run("rev-parse", "--verify", "HEAD");
  const status = await run("status", "--porcelain", "--untracked-files=normal");
  return { repositoryId: identity.repositoryId, cloneId: identity.cloneId, worktreeId: identity.worktreeId,
    branch, revision, headState: revision ? (branch ? "branch" : "detached") : (branch ? "unborn" : "unknown"),
    dirty: status === null ? "unknown" : status.length > 0, capturedAt: new Date().toISOString() };
}

export async function prepareObservation(store: ContextStore, input: Omit<Observation, "observationId" | "timestamp">) {
  if (!input.text.trim() || Buffer.byteLength(input.text) > 16 * 1024) throw new Error("Observation text must contain 1 to 16384 UTF-8 bytes");
  if (!["decision", "constraint", "failed_approach", "relationship", "unresolved_work", "operational_knowledge", "other"].includes(input.category)) throw new Error("Invalid observation category");
  const provenance = await store.observationProvenance(input);
  return { text: input.text, category: input.category, evidenceIds: [...new Set(input.evidenceIds.map((id) => id.replace(/^evidence:\/\//, "")))],
    queryIds: [...new Set(input.queryIds.map((id) => id.replace(/^query:\/\//, "")))], provenance,
    support: provenance.evidence.length ? "unverified" : "unsupported" };
}

/** Prepare once, then retain this input unchanged for same-key retries after uncertain commits. */
export async function prepareObservationEvent(
  store: ContextStore,
  identity: ContextOutIdentity,
  input: Omit<Observation, "observationId" | "timestamp"> & { observationId: string; idempotencyKey: string },
): Promise<ContextOutEventInput> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  let storeWorktree: string;
  try {
    const result = await exec("git", ["-C", dirname(dirname(store.root)), "rev-parse", "--show-toplevel"], { env, timeout: 2000, maxBuffer: 64 * 1024 });
    storeWorktree = await realpath(result.stdout.trim());
  } catch { throw new Error("Cannot verify observation evidence origin"); }
  if (storeWorktree !== await realpath(identity.worktreeRoot)) throw new Error("Observation evidence belongs to a different worktree");
  const payload = await prepareObservation(store, input);
  const origin = await originSnapshot(identity);
  const metadata: RevisionMetadata = {
    branch: origin.branch, revision: origin.revision,
    branchState: origin.headState === "branch" ? "named" : origin.headState as RevisionMetadata["branchState"],
    workingTree: origin.dirty === "unknown" ? "unknown" : origin.dirty ? "dirty" : "clean",
  };
  return { idempotencyKey: input.idempotencyKey, subjectId: input.observationId.replace(/^observation:\/\//, ""),
    type: "observation.created", metadata, payload };
}
