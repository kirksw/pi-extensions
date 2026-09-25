import { safeWorkspaceRelative } from "./availability.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import duckdb from "duckdb";
import { replayContextOutEvents, type ContextOutEvent, type ContextOutReplay, type ReplayRecord } from "./events.js";
import type { ContextOutIdentity } from "./identity.js";

/** Lifecycle payloads are deliberately separate from review/approval. IDs are bare ledger IDs. */
export type LifecyclePayload = { predecessorEventId: string } & (
  { reason?: string } | { replacementObservationId: string } | { observationId: string }
);
export type CandidateProposalPayload = {
  observationId: string; scope: "repo" | "architecture" | "organization"; target: string; rationale: string;
};
export type ProjectionIssue = { eventId: string; subjectId: string; kind: "invalid" | "unresolved" | "conflict"; reason: string };
export type ProjectedObservation = {
  observationId: string; creationEventId: string; text: string; category: string;
  origin: ContextOutEvent["origin"]; metadata: ContextOutEvent["metadata"]; sessionId: string | null; timestamp: string; migration?: { importedAt: string; originAssignment: string };
  state: "active" | "retracted" | "superseded" | "conflict";
  headEventId: string; replacementObservationId?: string; supportObservationIds: string[];
  support: "unsupported" | "unverified"; supportWarning: string; supportLinksOmitted: number;
};
export type ProjectedCandidate = CandidateProposalPayload & {
  candidateId: string; eventId: string; origin: ContextOutEvent["origin"]; status: "proposed";
};
export const PROJECTION_LIMITS = Object.freeze({ queryBytes: 1024, scanRows: 1000, scanBytes: 1024 * 1024,
  results: 100, responseBytes: 64 * 1024, milliseconds: 2000 });
export type ProjectionCoverage = {
  generation: string; events: number; incompleteTails: number; issues: number;
  source: "complete" | "incomplete" | "error" | "not-loaded";
};
export type ProjectionQuery = {
  scope?: "worktree" | "repository"; history?: boolean; branch?: string; revision?: string;
  query?: string; limit?: number; scanLimit?: number; responseBytes?: number; cursor?: string;
};
export type ProjectionPage<T> = { results: T[]; coverage: ProjectionCoverage; complete: boolean; scanComplete: boolean;
  scanned: number; scannedBytes: number; nextCursor?: string; stopReason?: "scan" | "results" | "bytes" | "time" };
const categories = ["decision", "constraint", "failed_approach", "relationship", "unresolved_work", "operational_knowledge", "other"];
const json = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${json((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected payload object");
  return value as Record<string, unknown>;
};
const id = (v: unknown): string => { if (typeof v !== "string" || !v.length || v.length > 4096 || v.includes("://")) throw new Error("Expected bare ID"); return v; };
const string = (v: unknown): string => { if (typeof v !== "string") throw new Error("Expected string"); return v; };
// Older query snapshots retained the display URI; normalize only in the projection.
const evidenceId = (v: unknown) => id(typeof v === "string" ? v.replace(/^evidence:\/\//, "") : v);
const ids = (v: unknown): string[] => { if (!Array.isArray(v) || v.length > 128) throw new Error("Expected bounded references"); return v.map(id); };
const sameOrigin = (a: ContextOutEvent, b: ContextOutEvent) => ["repositoryId", "cloneId", "worktreeId"].every(k => a.origin[k as keyof typeof a.origin] === b.origin[k as keyof typeof b.origin]);

function validateCreation(e: ContextOutEvent): Record<string, unknown> {
  const p = object(e.payload), text = string(p.text);
  if (!text.trim() || Buffer.byteLength(text) > 16384 || !categories.includes(string(p.category))) throw new Error("Invalid observation text/category");
  const evidenceIds = ids(p.evidenceIds), queryIds = ids(p.queryIds), provenance = object(p.provenance);
  if (!Array.isArray(provenance.evidence) || !Array.isArray(provenance.queries) || provenance.evidence.length > 128
    || provenance.queries.length > 128 || Buffer.byteLength(json(provenance)) > 192 * 1024) throw new Error("Invalid provenance budget");
  const evidence = new Map<string, Record<string, unknown>>(), queries = new Map<string, Record<string, unknown>>();
  for (const raw of provenance.evidence) {
    const v = object(raw), key = id(v.evidenceId);
    if (evidence.has(key) || "rawPath" in v || "arguments" in v || !["unknown", "partial"].includes(string(v.coverage))) throw new Error("Invalid evidence snapshot");
    for (const field of ["tool", "timestamp", "source", "shape", "sha256"]) string(v[field]);
    if (!Number.isSafeInteger(v.sizeBytes) || Number(v.sizeBytes) < 0) throw new Error("Invalid evidence size");
    if (v.workspaceRelative !== undefined && !safeWorkspaceRelative(v.workspaceRelative)) throw new Error("Invalid workspace locator");
    ids(v.dependencies); evidence.set(key, v);
  }
  for (const raw of provenance.queries) {
    const v = object(raw), key = id(v.queryId);
    if (queries.has(key) || !["sql", "jq"].includes(string(v.language))) throw new Error("Invalid query snapshot");
    string(v.query); string(v.timestamp); evidenceId(v.evidenceId);
    if (v.outputEvidenceId !== null) id(v.outputEvidenceId);
    queries.set(key, v);
  }
  const refs = [...evidenceIds, ...[...evidence.values()].flatMap(v => ids(v.dependencies)),
    ...[...queries.values()].flatMap(v => [evidenceId(v.evidenceId), ...(v.outputEvidenceId === null ? [] : [id(v.outputEvidenceId)])])];
  if (refs.some(ref => !evidence.has(ref)) || queryIds.some(ref => !queries.has(ref))) throw new Error("Missing provenance snapshot reference");
  if (p.support !== (evidence.size ? "unverified" : "unsupported")) throw new Error("Invalid support label");
  return p;
}

function reduce(records: ReplayRecord[]) {
  const events = records.map(r => r.event).sort((a, b) => a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
  const issues: ProjectionIssue[] = [], creations = new Map<string, ContextOutEvent>(), observations = new Map<string, ProjectedObservation>();
  const candidates: ProjectedCandidate[] = [];
  const issue = (e: ContextOutEvent, kind: ProjectionIssue["kind"], reason: string) => issues.push({ eventId: e.eventId, subjectId: e.subjectId, kind, reason });
  const groups = new Map<string, ContextOutEvent[]>();
  for (const e of events.filter(e => e.type === "observation.created")) groups.set(e.subjectId, [...(groups.get(e.subjectId) ?? []), e]);
  for (const [subject, group] of groups) {
    // Subject collisions have no arbitrary winner, including collisions from another origin.
    if (group.length !== 1) { group.forEach(e => issue(e, "conflict", "Multiple creation events for subject")); continue; }
    const e = group[0];
    try {
      const p = validateCreation(e); creations.set(subject, e);
      const migration = p.migration ? object(p.migration) : null;
      if (migration && (migration.version !== 1 || typeof migration.originalTimestamp !== "string" || !Number.isFinite(Date.parse(migration.originalTimestamp)))) throw new Error("Invalid migration provenance");
      observations.set(subject, { observationId: subject, creationEventId: e.eventId, text: string(p.text), category: string(p.category),
        origin: e.origin, metadata: e.metadata, sessionId: migration ? null : e.sessionId, timestamp: migration ? String(migration.originalTimestamp) : e.timestamp,
        ...(migration ? { migration: { importedAt: e.timestamp, originAssignment: "selected-worktree; historical origin unknown" } } : {}), state: "active", headEventId: e.eventId,
        supportObservationIds: [], supportLinksOmitted: 0, support: p.support as "unsupported" | "unverified",
        supportWarning: p.support === "unsupported" ? "No linked support" : "Stored snapshots only; evidence availability has not been inspected" });
    } catch (error) { issue(e, "invalid", (error as Error).message); }
  }
  const transitions = new Map<string, ContextOutEvent[]>();
  for (const e of events.filter(e => e.type !== "observation.created")) {
    try {
      const p = object(e.payload);
      const subject = e.type === "candidate.proposed" ? id(p.observationId) : e.subjectId;
      const owner = creations.get(subject);
      if (!owner) { issue(e, "unresolved", "Missing or invalid observation creation"); continue; }
      if (!sameOrigin(e, owner)) throw new Error("Cross-origin mutation is forbidden");
      if (e.type === "candidate.proposed") {
        if (!["repo", "architecture", "organization"].includes(string(p.scope))) throw new Error("Invalid candidate artifact category");
        candidates.push({ candidateId: e.subjectId, eventId: e.eventId, observationId: subject, scope: p.scope as CandidateProposalPayload["scope"],
          target: string(p.target), rationale: string(p.rationale), origin: e.origin, status: "proposed" });
        continue;
      }
      const predecessor = id(p.predecessorEventId);
      if (e.type === "observation.superseded" || e.type === "support.linked") {
        const target = id(e.type === "support.linked" ? p.observationId : p.replacementObservationId);
        const reference = creations.get(target);
        if (!reference) { issue(e, "unresolved", "Missing or invalid referenced observation"); continue; }
        if (target === subject || !sameOrigin(e, reference)) throw new Error("Support/replacement must be a different observation in the same origin");
      }
      if (e.type === "observation.retracted" && p.reason !== undefined) string(p.reason);
      transitions.set(predecessor, [...(transitions.get(predecessor) ?? []), e]);
    } catch (error) { issue(e, "invalid", (error as Error).message); }
  }
  const visited = new Set<string>();
  for (const [subject, observation] of observations) {
    const supportIds = new Set<string>();
    for (;;) {
      const successors = (transitions.get(observation.headEventId) ?? []).filter(e => e.subjectId === subject);
      if (!successors.length) break;
      successors.forEach(e => visited.add(e.eventId));
      if (observation.state !== "active") { successors.forEach(e => issue(e, "invalid", "Transition after terminal lifecycle state")); break; }
      if (successors.length > 1) {
        observation.state = "conflict"; successors.forEach(e => issue(e, "conflict", "Competing successors of predecessor event")); break;
      }
      const e = successors[0], p = object(e.payload); observation.headEventId = e.eventId;
      if (e.type === "support.linked") {
        supportIds.add(id(p.observationId));
        observation.supportObservationIds = [...supportIds].sort().slice(0, 128);
        observation.supportLinksOmitted = Math.max(0, supportIds.size - 128);
        observation.support = "unverified"; observation.supportWarning = "Linked claims and stored snapshots are unverified; no evidence inspection performed";
      } else if (e.type === "observation.retracted") observation.state = "retracted";
      else { observation.state = "superseded"; observation.replacementObservationId = id(p.replacementObservationId); }
    }
  }
  for (const list of transitions.values()) for (const e of list) if (!visited.has(e.eventId)) issue(e, "unresolved", "Predecessor missing, wrong subject, cyclic, or on a conflicted/terminal branch");
  const candidateCounts = new Map<string, number>();
  candidates.forEach(c => candidateCounts.set(c.candidateId, (candidateCounts.get(c.candidateId) ?? 0) + 1));
  const validCandidates = candidates.filter(c => {
    if (candidateCounts.get(c.candidateId) === 1) return true;
    issue(events.find(e => e.eventId === c.eventId)!, "conflict", "Multiple proposals for candidate ID"); return false;
  });
  return { observations: [...observations.values()], candidates: validCandidates, issues };
}

/** A unique file per instance/process; close releases native resources, never removes authoritative data. */
export async function openContextOutProjection(identity: ContextOutIdentity): Promise<ContextOutProjection> {
  return ContextOutProjection.open(identity);
}
export class ContextOutProjection {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private coverage: ProjectionCoverage = { generation: "", events: 0, incompleteTails: 0, issues: 0, source: "not-loaded" };
  private constructor(private identity: ContextOutIdentity, readonly path: string, private db: duckdb.Database, private connection: duckdb.Connection) {}
  static async open(identity: ContextOutIdentity): Promise<ContextOutProjection> {
    const root = join(identity.worktreeRoot, ".pi", "context", "context-out", "projections");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, `${process.pid}-`)), path = join(directory, "projection.duckdb");
    const db = await new Promise<duckdb.Database>((resolve, reject) => {
      const instance = new duckdb.Database(path, error => error ? reject(error) : resolve(instance));
    });
    const projection = new ContextOutProjection(structuredClone(identity), path, db, db.connect());
    try {
      await projection.run("CREATE TABLE events (id VARCHAR PRIMARY KEY, writer VARCHAR, sequence BIGINT, path VARCHAR, start_offset BIGINT, end_offset BIGINT, signature VARCHAR, body VARCHAR, UNIQUE(writer, sequence))");
      await projection.run("CREATE TABLE items (kind VARCHAR, id VARCHAR, clone_id VARCHAR, worktree_id VARCHAR, state VARCHAR, branch VARCHAR, revision VARCHAR, body VARCHAR, PRIMARY KEY(kind, id))");
      await projection.refresh(); return projection;
    } catch (e) { await projection.close(); throw e; }
  }
  private run(sql: string, values: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => this.connection.run(sql, ...values, error => error ? reject(error) : resolve()));
  }
  private all(sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => this.connection.all(sql, ...values, (error, rows) => error ? reject(error) : resolve(rows)));
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Context Out projection is closed"));
    const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next;
  }
  /** Replays all shards; exact reimports are inert. Source corruption leaves the previous cache explicitly stale. */
  refresh(): Promise<ProjectionCoverage> { return this.serialized(() => this.importSource(false)); }
  /** Transactionally replace the disposable cache from the authoritative source. */
  rebuild(): Promise<ProjectionCoverage> { return this.serialized(() => this.importSource(true)); }
  private async importSource(rebuild: boolean): Promise<ProjectionCoverage> {
    let replay: ContextOutReplay;
    try {
      replay = await replayContextOutEvents(this.identity);
      const old = await this.all("SELECT id, signature FROM events");
      const incoming = new Map(replay.records.map(r => [r.event.eventId, digest(r)]));
      // Rebuild must not become a way to silently bless a mutated immutable source.
      for (const row of old) if (incoming.get(String(row.id)) !== row.signature) throw new Error("Previously imported event changed or disappeared");
      const generation = digest(replay), reduced = reduce(replay.records);
      if (!rebuild && generation === this.coverage.generation) {
        this.coverage.source = replay.incompleteTails.length ? "incomplete" : "complete"; return { ...this.coverage };
      }
      await this.run("BEGIN TRANSACTION");
      try {
        await this.run("DELETE FROM events"); await this.run("DELETE FROM items");
        for (const r of replay.records) {
          await this.run("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [r.event.eventId, r.event.writerId, r.event.sequence, r.path, r.offset, r.endOffset, digest(r), json(r.event)]);
          await this.insert("event", r.event.eventId, r.event.origin, r.event.type, r.event.metadata.branch, r.event.metadata.revision, r.event);
        }
        for (const o of reduced.observations) await this.insert("observation", o.observationId, o.origin, o.state, o.metadata.branch, o.metadata.revision, o);
        for (const c of reduced.candidates) await this.insert("candidate", c.candidateId, c.origin, "proposed", null, null, c);
        for (const i of reduced.issues) {
          const e = replay.records.find(r => r.event.eventId === i.eventId)!.event;
          await this.insert("issue", i.eventId, e.origin, i.kind, null, null, i);
        }
        await this.run("COMMIT");
      } catch (e) { await this.run("ROLLBACK"); throw e; }
      this.coverage = { generation, events: replay.records.length, incompleteTails: replay.incompleteTails.length,
        issues: reduced.issues.length, source: replay.incompleteTails.length ? "incomplete" : "complete" };
      return { ...this.coverage };
    } catch (e) { this.coverage.source = "error"; throw e; }
  }
  private insert(kind: string, id: string, origin: ContextOutEvent["origin"], state: string, branch: string | null, revision: string | null, body: unknown) {
    return this.run("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [kind, id, origin.cloneId, origin.worktreeId, state, branch, revision, json(body)]);
  }
  search(input: ProjectionQuery = {}): Promise<ProjectionPage<ProjectedObservation>> { return this.page("observation", input); }
  read(observationId: string, input: Omit<ProjectionQuery, "query" | "cursor" | "history"> = {}): Promise<ProjectionPage<ProjectedObservation>> {
    return this.page("observation", { ...input, history: true }, id(observationId.replace(/^observation:\/\//, "")));
  }
  /** Internal lifecycle lookup is scoped but independent of model response budgets. */
  lookup(observationId: string, scope: "worktree" | "repository" = "worktree"): Promise<ProjectedObservation | undefined> {
    return this.serialized(async () => {
      const where = scope === "repository" ? "" : " AND clone_id = ? AND worktree_id = ?";
      const values = [id(observationId.replace(/^observation:\/\//, "")), ...(scope === "repository" ? [] : [this.identity.cloneId, this.identity.worktreeId])];
      const row = (await this.all(`SELECT body FROM items WHERE kind = 'observation' AND id = ?${where}`, values))[0];
      return row ? JSON.parse(String(row.body)) : undefined;
    });
  }
  /** Explicit immutable event history, including original provenance snapshots; oversized rows report bytes. */
  history(input: ProjectionQuery = {}): Promise<ProjectionPage<ContextOutEvent>> { return this.page("event", input); }
  candidates(input: ProjectionQuery = {}): Promise<ProjectionPage<ProjectedCandidate>> { return this.page("candidate", input); }
  issues(input: ProjectionQuery = {}): Promise<ProjectionPage<ProjectionIssue>> { return this.page("issue", input); }
  private page<T>(kind: string, input: ProjectionQuery, subject?: string): Promise<ProjectionPage<T>> {
    const snapshot = structuredClone(input);
    return this.serialized(async () => {
      input = snapshot;
      const integer = (v: number | undefined, fallback: number, min: number, max: number) => {
        const n = v ?? fallback; if (!Number.isInteger(n) || n < min || n > max) throw new Error("Invalid projection query budget"); return n;
      };
      const limit = integer(input.limit, 20, 1, PROJECTION_LIMITS.results);
      const scanLimit = integer(input.scanLimit, PROJECTION_LIMITS.scanRows, 1, PROJECTION_LIMITS.scanRows);
      const byteLimit = integer(input.responseBytes, PROJECTION_LIMITS.responseBytes, 8192, PROJECTION_LIMITS.responseBytes);
      const query = input.query ?? "";
      if (typeof query !== "string" || Buffer.byteLength(query) > PROJECTION_LIMITS.queryBytes) throw new Error("Query exceeds byte budget");
      if (input.scope !== undefined && !["worktree", "repository"].includes(input.scope)) throw new Error("Invalid projection scope");
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const fingerprint = digest({ kind, subject: subject ?? null, scope: input.scope ?? "worktree", history: input.history ?? false,
        branch: input.branch ?? null, revision: input.revision ?? null, query });
      let after = "";
      if (input.cursor) {
        if (input.cursor.length > 16384) throw new Error("Invalid cursor");
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (cursor.generation !== this.coverage.generation || cursor.fingerprint !== fingerprint) throw new Error("Stale or mismatched projection cursor");
        if (typeof cursor.afterHash === "string" && /^[a-f0-9]{64}$/.test(cursor.afterHash)) {
          const row = (await this.all("SELECT id FROM items WHERE kind = ? AND sha256(id) = ?", [kind, cursor.afterHash]))[0];
          if (!row) throw new Error("Invalid projection cursor position");
          after = String(row.id);
        } else if (typeof cursor.after === "string") after = cursor.after;
        else throw new Error("Invalid projection cursor");
      }
      const where = ["kind = ?", "id > ?"], values: unknown[] = [kind, after];
      if (input.scope !== "repository") { where.push("clone_id = ?", "worktree_id = ?"); values.push(this.identity.cloneId, this.identity.worktreeId); }
      if (subject !== undefined) { where.push("id = ?"); values.push(subject); }
      if (kind === "observation" && !input.history) where.push("state IN ('active', 'conflict')");
      for (const field of ["branch", "revision"] as const) if (input[field] !== undefined) {
        if (typeof input[field] !== "string" || Buffer.byteLength(input[field]!) > 4096) throw new Error("Invalid provenance filter");
        where.push(`${field} = ?`); values.push(input[field]);
      }
      const page: ProjectionPage<T> = { results: [], coverage: { ...this.coverage }, complete: false, scanComplete: false, scanned: 0, scannedBytes: 0 };
      const deadline = Date.now() + PROJECTION_LIMITS.milliseconds;
      // Fetch one row at a time: native result materialization cannot bypass the scan byte budget.
      for (;;) {
        if (Date.now() >= deadline) { page.stopReason = "time"; break; }
        const row = (await this.all(`SELECT id, body FROM items WHERE ${where.join(" AND ")} ORDER BY id LIMIT 1`, values))[0];
        if (!row) { page.scanComplete = true; page.complete = this.coverage.source === "complete" && this.coverage.issues === 0; break; }
        if (page.scanned >= scanLimit) { page.stopReason = "scan"; break; }
        const body = String(row.body), size = Buffer.byteLength(body);
        if (page.scannedBytes + size > PROJECTION_LIMITS.scanBytes) { page.stopReason = "scan"; break; }
        let value = JSON.parse(body);
        const searchable = kind === "observation" ? `${value.text} ${value.category}` : body;
        const matches = terms.every(term => searchable.toLowerCase().includes(term));
        if (matches && page.results.length >= limit) { page.stopReason = "results"; break; }
        // Hash cursor positions so long historical IDs cannot dominate response budgets.
        const nextCursor = Buffer.from(json({ generation: this.coverage.generation, fingerprint, afterHash: createHash("sha256").update(String(row.id)).digest("hex") })).toString("base64url");
        const fits = (item: unknown) => Buffer.byteLength(JSON.stringify({ ...page, results: [...page.results, item], nextCursor })) + 256 <= byteLimit;
        if (matches && !fits(value)) {
          if (page.results.length) { page.stopReason = "bytes"; break; }
          // An item that cannot fit an empty page must not trap the cursor forever.
          value = { ...(kind === "observation" ? { observationId: value.observationId, state: value.state, headEventId: value.headEventId }
            : kind === "candidate" ? { candidateId: value.candidateId, observationId: value.observationId, status: value.status } : { id: String(row.id) }),
            truncated: true, preview: body.slice(0, 512),
            warning: "Item exceeds response budget; use context_inspect_observation content/history for paged full text." };
          while (!fits(value) && value.preview.length) value.preview = value.preview.slice(0, Math.floor(value.preview.length / 2));
          if (!fits(value)) value = { truncated: true, idHash: createHash("sha256").update(String(row.id)).digest("hex"),
            warning: "Item identifiers exceed response budget; inspect by its original ledger ID.", identifiersOmitted: true };
          if (!fits(value)) throw new Error("Response budget cannot fit an item marker");
        }
        page.scanned++; page.scannedBytes += size; after = String(row.id); values[1] = after;
        if (matches) page.results.push(value);
      }
      if (!page.scanComplete) page.nextCursor = Buffer.from(json({ generation: this.coverage.generation, fingerprint, ...(after ? { afterHash: createHash("sha256").update(after).digest("hex") } : { after: "" }) })).toString("base64url");
      return page;
    });
  }
  close(): Promise<void> {
    if (this.closed) return this.queue.then(() => {});
    this.closed = true;
    const next = this.queue.then(async () => {
      try { await new Promise<void>((resolve, reject) => this.connection.close(e => e ? reject(e) : resolve())); }
      finally { await new Promise<void>((resolve, reject) => this.db.close(e => e ? reject(e) : resolve())); }
    });
    this.queue = next; return next;
  }
}
