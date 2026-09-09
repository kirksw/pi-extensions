import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, lstat, rmdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import type { ContextOutIdentity } from "./identity.js";

export const CONTEXT_OUT_EVENT_VERSION = 1;
/** Includes the terminating newline; applies to writes and replay. */
export const MAX_CONTEXT_OUT_EVENT_BYTES = 256 * 1024;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type EventType = "observation.created" | "observation.superseded" | "observation.retracted" | "support.linked" | "candidate.proposed";
export type RevisionMetadata = Readonly<{
  branch: string | null;
  branchState: "named" | "detached" | "unborn" | "unknown";
  revision: string | null;
  workingTree: "clean" | "dirty" | "unknown";
}>;
export type ContextOutEventInput = Readonly<{
  idempotencyKey: string; subjectId: string; type: EventType;
  metadata: RevisionMetadata; payload: JsonValue;
}>;
export type ContextOutEvent = ContextOutEventInput & Readonly<{
  version: 1; eventId: string; sessionId: string; writerId: string; sequence: number; timestamp: string;
  scope: "worktree";
  origin: Readonly<Pick<ContextOutIdentity, "repositoryId" | "canonicalRemote" | "cloneId" | "worktreeId" | "worktreeRoot" | "commonGitDirectory" | "gitDirectory">>;
}>;
export class ContextOutLockedError extends Error {
  constructor(public readonly lockPath: string) { super(`Context Out session is locked: ${lockPath}. No automatic stale-lock recovery; release only after verifying the owner has stopped.`); }
}
export class ContextOutRetryConflictError extends Error {}
export class ContextOutCorruptEventError extends Error {}
export class ContextOutCommitUncertainError extends Error {
  constructor(public readonly idempotencyKey: string, cause: unknown) {
    super(`Context Out commit outcome is uncertain; retry with the same idempotency key (${idempotencyKey}) and identical input.`, { cause });
  }
}
export type ReplayRecord = Readonly<{ event: ContextOutEvent; path: string; offset: number; endOffset: number }>;
export type ContextOutReplay = { records: ReplayRecord[]; incompleteTails: { path: string; offset: number; bytes: number }[] };
const types: EventType[] = ["observation.created", "observation.superseded", "observation.retracted", "support.linked", "candidate.proposed"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sessionDirectory = (root: string, session: string) => join(root, hash(session));
const eventId = (repository: string, session: string, key: string) => hash(JSON.stringify([1, repository, session, key]));
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 4096) throw new Error("Expected a nonempty string of at most 4096 characters");
}
/** Canonical JSON also rejects values JSON.stringify would silently discard or coerce. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("JSON nesting exceeds 64 levels");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("Sparse or decorated arrays are not JSON");
    return `[${value.map(v => canonical(v, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object" && value && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if (Object.getOwnPropertySymbols(value).length) throw new Error("Symbol keys are not JSON");
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  throw new Error("Expected finite JSON data");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function validateInput(input: ContextOutEventInput): void {
  text(input.idempotencyKey); text(input.subjectId);
  if (!types.includes(input.type)) throw new Error("Unsupported event type");
  const m = input.metadata;
  if (!m || !["named", "detached", "unborn", "unknown"].includes(m.branchState)
    || !["clean", "dirty", "unknown"].includes(m.workingTree)) throw new Error("Invalid revision metadata");
  if (m.branch !== null) text(m.branch);
  if (m.revision !== null) text(m.revision);
  if ((m.branchState === "named" || m.branchState === "unborn") !== (m.branch !== null)
    || (m.branchState === "unborn" && m.revision !== null)) throw new Error("Inconsistent revision metadata");
  canonical(input.payload);
}
function inputOf(e: ContextOutEventInput): ContextOutEventInput {
  return { idempotencyKey: e.idempotencyKey, subjectId: e.subjectId, type: e.type, metadata: e.metadata, payload: e.payload };
}
function validateEvent(e: ContextOutEvent): void {
  validateInput(e); text(e.sessionId); text(e.writerId);
  if (e.version !== 1 || e.scope !== "worktree" || !Number.isSafeInteger(e.sequence) || e.sequence < 1
    || typeof e.timestamp !== "string" || !Number.isFinite(Date.parse(e.timestamp))) throw new Error("Invalid event envelope/version");
  for (const k of ["repositoryId", "cloneId", "worktreeId", "worktreeRoot", "commonGitDirectory", "gitDirectory"] as const) text(e.origin[k]);
  if (e.origin.canonicalRemote !== null) text(e.origin.canonicalRemote);
  if (e.eventId !== eventId(e.origin.repositoryId, e.sessionId, e.idempotencyKey)) throw new Error("Invalid event identity");
  if (!/^[0-9a-f-]{36}$/.test(e.writerId)) throw new Error("Invalid writer identity");
}
async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Event directory must be a real directory");
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Deterministic shard/offset order, not lifecycle or wall-clock order. No malformed complete line is skipped. */
export async function replayContextOutEvents(identity: ContextOutIdentity, sessionId?: string): Promise<ContextOutReplay> {
  const result: ContextOutReplay = { records: [], incompleteTails: [] };
  const sessions = sessionId === undefined ? (await readdir(identity.eventsRoot)).filter(n => /^[0-9a-f]{64}$/.test(n)).sort() : [hash(sessionId)];
  const seen = new Map<string, string>();
  for (const session of sessions) {
    const dir = join(identity.eventsRoot, session);
    let files: string[];
    try { files = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if ((await lstat(dir)).isSymbolicLink()) throw new ContextOutCorruptEventError(`Symlink session: ${dir}`);
    for (const name of files.filter(n => n.endsWith(".jsonl")).sort()) {
      const path = join(dir, name);
      if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new ContextOutCorruptEventError(`Invalid shard: ${path}`);
      const handle = await open(path, "r");
      let pending = Buffer.alloc(0), offset = 0, sequence = 0;
      try {
        const chunk = Buffer.alloc(64 * 1024);
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (!bytesRead) break;
          pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
          let newline: number;
          while ((newline = pending.indexOf(10)) !== -1) {
            try {
              if (newline + 1 > MAX_CONTEXT_OUT_EVENT_BYTES) throw new Error("Oversized record");
              const e = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline))) as ContextOutEvent;
              validateEvent(e);
              if (e.origin.repositoryId !== identity.repositoryId || hash(e.sessionId) !== session || `${e.writerId}.jsonl` !== name
                || e.sequence !== sequence + 1) throw new Error("Shard provenance/sequence mismatch");
              const signature = canonical({ ...inputOf(e), origin: e.origin });
              if (seen.has(e.eventId)) throw new Error(seen.get(e.eventId) === signature ? "Duplicate committed event" : "Conflicting committed event");
              seen.set(e.eventId, signature);
              result.records.push({ event: freeze(e), path, offset, endOffset: offset + newline + 1 });
              sequence = e.sequence;
            } catch (cause) { throw new ContextOutCorruptEventError(`Invalid complete event at ${path}:${offset}`, { cause }); }
            offset += newline + 1; pending = pending.subarray(newline + 1);
          }
          if (pending.length >= MAX_CONTEXT_OUT_EVENT_BYTES) throw new ContextOutCorruptEventError(`Oversized tail at ${path}:${offset}`);
        }
        if (pending.length) result.incompleteTails.push({ path, offset, bytes: pending.length });
      } finally { await handle.close(); }
    }
  }
  return result;
}

export type ContextOutWriterOptions = {
  /** Test fault injection at durability boundaries. Throwing always produces an uncertain result. */
  fault?: (stage: "beforeAppend" | "afterAppend" | "afterSync") => void | Promise<void>;
};
export interface ContextOutEventWriter {
  append(input: ContextOutEventInput): Promise<ContextOutEvent>;
  close(): Promise<void>;
}
/** Local filesystems with exclusive mkdir and file/directory fsync are required; no network-FS guarantee. */
export async function openContextOutEventWriter(identity: ContextOutIdentity, sessionId: string, options: ContextOutWriterOptions = {}): Promise<ContextOutEventWriter> {
  text(sessionId);
  const trusted = JSON.parse(JSON.stringify(identity)) as ContextOutIdentity;
  const origin = freeze(Object.fromEntries(["repositoryId", "canonicalRemote", "cloneId", "worktreeId", "worktreeRoot", "commonGitDirectory", "gitDirectory"].map(k => [k, trusted[k as keyof ContextOutIdentity]])) as ContextOutEvent["origin"]);
  const dir = sessionDirectory(trusted.eventsRoot, sessionId), lock = join(dir, "writer.lock");
  await directory(trusted.eventsRoot); await directory(dir);
  try { await mkdir(lock, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ContextOutLockedError(lock); throw e; }
  let handle: FileHandle | undefined, writerId = "", sequence = 0, closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  async function fresh(): Promise<void> {
    writerId = randomUUID(); sequence = 0;
    handle = await open(join(dir, `${writerId}.jsonl`), "wx", 0o600);
    await handle.sync(); await syncDirectory(dir); await syncDirectory(trusted.eventsRoot);
    await syncDirectory(trusted.repositoryRoot); await syncDirectory(dirname(trusted.repositoryRoot)); await syncDirectory(trusted.storageRoot);
  }
  try { await replayContextOutEvents(trusted, sessionId); await fresh(); }
  catch (e) { await handle?.close(); await rmdir(lock); throw e; }
  return {
    append(input) {
      if (closed) return Promise.reject(new Error("Context Out writer is closed"));
      let snapshot: ContextOutEventInput;
      try { snapshot = JSON.parse(canonical(inputOf(input))); validateInput(snapshot); }
      catch (e) { return Promise.reject(e); }
      const run = queue.then(async () => {
        const replay = await replayContextOutEvents(trusted, sessionId);
        const existing = replay.records.find(r => r.event.idempotencyKey === snapshot.idempotencyKey);
        if (existing && canonical({ ...inputOf(existing.event), origin: existing.event.origin }) !== canonical({ ...snapshot, origin })) {
          throw new ContextOutRetryConflictError("Idempotency key already used with different input or origin");
        }
        const event: ContextOutEvent = existing?.event ?? freeze({ ...snapshot, version: 1, scope: "worktree", origin,
          eventId: eventId(trusted.repositoryId, sessionId, snapshot.idempotencyKey), sessionId,
          writerId, sequence: sequence + 1, timestamp: new Date().toISOString() });
        validateEvent(event);
        if (Buffer.byteLength(canonical(event) + "\n") > MAX_CONTEXT_OUT_EVENT_BYTES) throw new Error("Context Out event exceeds byte budget");
        try {
          if (existing) {
            // A visible complete line may be from an earlier failed fsync: make it durable before acknowledging it.
            const prior = await open(existing.path, "r+");
            try { await prior.sync(); } finally { await prior.close(); }
            await syncDirectory(dir); await syncDirectory(trusted.eventsRoot);
            return existing.event;
          }
          if (!handle) await fresh();
          const actual = freeze({ ...event, writerId, sequence: sequence + 1 });
          const bytes = Buffer.from(canonical(actual) + "\n");
          await options.fault?.("beforeAppend");
          let written = 0;
          while (written < bytes.length) {
            const result = await handle!.write(bytes, written, bytes.length - written, null);
            if (!result.bytesWritten) throw new Error("Zero-byte append");
            written += result.bytesWritten;
          }
          await options.fault?.("afterAppend"); await handle!.sync(); await options.fault?.("afterSync");
          sequence++; return actual;
        } catch (cause) {
          // Never append after a possibly partial record. A retry scans complete records, then uses a new shard.
          const failed = handle; handle = undefined;
          try { await failed?.close(); } catch { /* The commit remains uncertain regardless of close outcome. */ }
          throw new ContextOutCommitUncertainError(snapshot.idempotencyKey, cause);
        }
      });
      queue = run.catch(() => {}); return run;
    },
    close() {
      if (closed) return queue.then(() => {});
      closed = true;
      const run = queue.then(async () => { await handle?.close(); handle = undefined; await rmdir(lock); });
      queue = run; return run;
    },
  };
}
