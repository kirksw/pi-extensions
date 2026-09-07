import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import duckdb from "duckdb";
import type { ContextOutIdentity } from "./identity.js";
import { openContextOutEventWriter, replayContextOutEvents, type ContextOutEventInput, type ContextOutWriterOptions, type JsonValue } from "./events.js";

/** Fail closed on oversized sources rather than importing a misleading partial inventory. */
export const MIGRATION_LIMITS = Object.freeze({ ledgerBytes: 4 * 1024 * 1024, databaseBytes: 64 * 1024 * 1024,
  snapshotBytes: 8 * 1024 * 1024, rows: 10000, reportItems: 100, reportBytes: 64 * 1024, eventBytes: 224 * 1024, planBytes: 16 * 1024 * 1024 });
type Row = Record<string, unknown>;
type Inventory = { observations: Row[]; observation_evidence: Row[]; evidence_queries: Row[]; artifact_candidates: Row[]; evidence: Row[] };
export type MigrationItem = { kind: "observation" | "candidate" | "ledger" | "link"; id: string; outcome: "accepted" | "skipped" | "unresolved"; reason: string };
export type MigrationReport = {
  mode: "dry-run" | "import"; databasePresent: boolean; ledgerBacked: number; matchingDatabase: number; databaseOnly: number;
  candidates: number; malformed: number; accepted: number; skipped: number; unresolved: number; committed: number;
  items: MigrationItem[]; omittedItems: number;
  assignment: { repositoryId: string; cloneId: string; worktreeId: string; historicalSession: null; branch: null; revision: null; migrationSession: string };
  warnings: string[];
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Row)[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
const bare = (value: unknown): string => {
  if (typeof value !== "string" || !value.length || value.length > 4096 || value.includes("://")) throw new Error("Invalid bare legacy ID");
  return value;
};
const text = (value: unknown): string => { if (typeof value !== "string") throw new Error("Invalid legacy string"); return value; };
const date = (value: unknown): string => { const s = text(value); if (!Number.isFinite(Date.parse(s))) throw new Error("Invalid legacy timestamp"); return s; };
const ids = (value: unknown): string[] => { if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid legacy references"); return value.map(bare); };
const metadata = { branch: null, branchState: "unknown", revision: null, workingTree: "unknown" } as const;
const session = (identity: ContextOutIdentity) => `legacy-migration-v1:${identity.cloneId}:${identity.worktreeId}`;

// Only fixed selected-worktree paths are accepted; imported payloads never select files.
async function sourcePath(identity: ContextOutIdentity, suffix: string): Promise<string | undefined> {
  const path = join(identity.worktreeRoot, ".pi", "context", suffix);
  try {
    const info = await lstat(path), root = await realpath(identity.worktreeRoot), actual = await realpath(path);
    const rel = relative(root, actual);
    if (!info.isFile() || info.isSymbolicLink() || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Legacy source must be a regular file within the selected worktree");
    return path;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
async function ledger(identity: ContextOutIdentity): Promise<string> {
  const path = await sourcePath(identity, "observations/ledger.jsonl");
  if (!path) return "";
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(MIGRATION_LIMITS.ledgerBytes + 1); let length = 0;
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > MIGRATION_LIMITS.ledgerBytes) throw new Error("Legacy ledger exceeds migration input budget");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}
async function database(identity: ContextOutIdentity): Promise<{ present: boolean; rows: Inventory }> {
  const rows: Inventory = { observations: [], observation_evidence: [], evidence_queries: [], artifact_candidates: [], evidence: [] };
  const path = await sourcePath(identity, "state.duckdb");
  if (!path) return { present: false, rows };
  if ((await lstat(path)).size > MIGRATION_LIMITS.databaseBytes) throw new Error("Legacy database exceeds migration input budget");
  const wal = await sourcePath(identity, "state.duckdb.wal");
  if (wal && (await lstat(wal)).size > MIGRATION_LIMITS.databaseBytes) throw new Error("Legacy WAL exceeds migration input budget");
  const db = await new Promise<duckdb.Database>((resolve, reject) => {
    const instance = new duckdb.Database(path, { access_mode: "READ_ONLY", memory_limit: "128MB", threads: "1", enable_external_access: "false" }, error => error ? reject(error) : resolve(instance));
  });
  let connection: duckdb.Connection | undefined;
  try {
    connection = db.connect();
    const all = (sql: string): Promise<Row[]> => new Promise((resolve, reject) => connection!.all(sql, (error, result) => error ? reject(error) : resolve(result)));
    await all("BEGIN TRANSACTION");
    const tables = new Set((await all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'")).map(r => r.table_name));
    let bytes = 0, count = 0;
    for (const table of Object.keys(rows) as (keyof Inventory)[]) {
      if (!tables.has(table)) continue;
      const columns = table === "evidence" ? "evidence_id, tool, timestamp, source, size_bytes, shape, sha256, dependencies_json" : "*";
      // Budget serialized selected metadata inside SQL before materializing it in JS.
      const query = `SELECT ${columns} FROM ${table}`;
      const size = (await all(`SELECT count(*) AS n, coalesce(sum(octet_length(encode(to_json(t)))), 0) AS bytes FROM (${query}) t`))[0];
      count += Number(size.n); bytes += Number(size.bytes);
      if (count > MIGRATION_LIMITS.rows || bytes > MIGRATION_LIMITS.snapshotBytes) throw new Error("Legacy snapshot exceeds migration input budget");
      rows[table] = JSON.parse(JSON.stringify(await all(query), (_key, value) => typeof value === "bigint" ? Number(value) : value)) as Row[];
    }
    await all("ROLLBACK");
    return { present: true, rows };
  } finally {
    try { if (connection) await new Promise<void>((resolve, reject) => connection!.close(error => error ? reject(error) : resolve())); }
    finally { await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }
  }
}
function provenance(o: Row, db: Inventory) {
  const evidenceIds = ids(o.evidenceIds), queryIds = ids(o.queryIds);
  if (evidenceIds.length + queryIds.length > 128) throw new Error("Too many legacy references");
  const pending = [...evidenceIds], evidence: Row[] = [], queries: Row[] = [];
  for (const queryId of [...new Set(queryIds)]) {
    const matches = db.evidence_queries.filter(r => r.query_id === queryId);
    if (matches.length !== 1) throw new Error("Missing or ambiguous query lineage");
    const r = matches[0], evidenceId = bare(r.evidence_id), outputEvidenceId = r.output_evidence_id == null ? null : bare(r.output_evidence_id);
    if (!["sql", "jq"].includes(text(r.language))) throw new Error("Unsupported legacy query language");
    queries.push({ queryId, evidenceId, outputEvidenceId, language: r.language, query: text(r.query_text), timestamp: date(r.timestamp) });
    pending.push(evidenceId); if (outputEvidenceId) pending.push(outputEvidenceId);
  }
  const seen = new Set<string>();
  for (let i = 0; i < pending.length; i++) {
    const evidenceId = bare(pending[i]); if (seen.has(evidenceId)) continue;
    if (seen.size >= 128) throw new Error("Legacy dependency budget exceeded");
    seen.add(evidenceId);
    const matches = db.evidence.filter(r => r.evidence_id === evidenceId);
    if (matches.length !== 1) throw new Error("Missing or ambiguous evidence lineage");
    const r = matches[0], dependencies = ids(JSON.parse(text(r.dependencies_json)));
    if (!/^[a-f0-9]{64}$/.test(text(r.sha256)) || !Number.isSafeInteger(r.size_bytes) || Number(r.size_bytes) < 0) throw new Error("Incomplete legacy evidence metadata");
    evidence.push({ evidenceId, tool: text(r.tool), timestamp: date(r.timestamp), source: text(r.source), shape: text(r.shape),
      sha256: r.sha256, sizeBytes: r.size_bytes, dependencies, coverage: text(r.source).includes("partial:") ? "partial" : "unknown" });
    pending.push(...dependencies);
  }
  // Cycles are not resolvable historical lineage, even when every row exists.
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Cyclic legacy lineage"); if (done.has(id)) return;
    visiting.add(id); for (const dependency of evidence.find(e => e.evidenceId === id)!.dependencies as string[]) visit(dependency);
    visiting.delete(id); done.add(id);
  };
  for (const id of seen) visit(id);
  if (Buffer.byteLength(JSON.stringify({ evidence, queries })) > 192 * 1024) throw new Error("Legacy provenance byte budget exceeded");
  return { evidenceIds, queryIds, provenance: { evidence, queries }, support: evidence.length ? "unverified" : "unsupported" };
}
async function plan(identity: ContextOutIdentity): Promise<{ report: MigrationReport; events: ContextOutEventInput[] }> {
  const raw = await ledger(identity), db = await database(identity), events: ContextOutEventInput[] = [];
  const report: MigrationReport = { mode: "dry-run", databasePresent: db.present, ledgerBacked: 0, matchingDatabase: 0, databaseOnly: 0,
    candidates: db.rows.artifact_candidates.length, malformed: 0, accepted: 0, skipped: 0, unresolved: 0, committed: 0, items: [], omittedItems: 0,
    assignment: { repositoryId: identity.repositoryId, cloneId: identity.cloneId, worktreeId: identity.worktreeId,
      historicalSession: null, branch: null, revision: null, migrationSession: session(identity) },
    warnings: ["Origin is assigned to the selected worktree, not established historical provenance. The synthetic migration session is not the original session.",
      "Evidence content is not inspected or copied. Query definitions persist in events. Broken lineage is unresolved, never invented.",
      "Deleted worktrees cannot be recovered without an external copy. Close legacy writers before migration; oversized inputs fail closed."] };
  const item = (kind: MigrationItem["kind"], id: string, outcome: MigrationItem["outcome"], reason: string) => {
    report[outcome]++;
    const value = { kind, id: id.slice(0, 4096), outcome, reason: reason.slice(0, 512) };
    if (report.items.length < MIGRATION_LIMITS.reportItems && Buffer.byteLength(JSON.stringify(report)) + Buffer.byteLength(JSON.stringify(value)) < MIGRATION_LIMITS.reportBytes - 2048) report.items.push(value);
    else report.omittedItems++;
  };
  const observations = new Map<string, Row[]>();
  const lines = raw.split("\n");
  if (lines.length > MIGRATION_LIMITS.rows + 1) throw new Error("Legacy ledger exceeds migration row budget");
  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1 && !line) continue;
    try {
      if (index === lines.length - 1) throw new Error("Incomplete final ledger record");
      const o = JSON.parse(line) as Row, id = bare(o.observationId);
      observations.set(id, [...(observations.get(id) ?? []), o]); report.ledgerBacked++;
    } catch { report.malformed++; item("ledger", `line:${index + 1}`, "unresolved", "Malformed or incomplete ledger record"); }
  }
  const existing = (await replayContextOutEvents(identity)).records.map(r => r.event);
  let planBytes = 0;
  const propose = (kind: "observation" | "candidate", id: string, timestamp: string, payload: Row): boolean => {
    const input: ContextOutEventInput = { subjectId: id, type: kind === "observation" ? "observation.created" : "candidate.proposed",
      idempotencyKey: `legacy-v1:${kind}:${hash(id)}`, metadata,
      payload: { ...payload, migration: { version: 1, source: "selected-worktree-legacy", originalId: id, originalTimestamp: timestamp,
        historicalSession: null, historicalBranch: null, historicalRevision: null, originAssignment: "selected-worktree", sessionRole: "synthetic-migration-not-historical" } } as JsonValue };
    if (Buffer.byteLength(JSON.stringify(input)) > MIGRATION_LIMITS.eventBytes) throw new Error("Legacy event byte budget exceeded");
    const collisions = existing.filter(e => e.subjectId === id && e.type === input.type);
    if (collisions.length && (collisions.length !== 1 || collisions[0].sessionId !== session(identity)
      || collisions[0].idempotencyKey !== input.idempotencyKey || stable(collisions[0].payload) !== stable(input.payload)
      || collisions[0].origin.cloneId !== identity.cloneId || collisions[0].origin.worktreeId !== identity.worktreeId)) {
      item(kind, id, "unresolved", "Conflict with committed Context Out subject"); return false;
    }
    planBytes += Buffer.byteLength(JSON.stringify(input));
    if (planBytes > MIGRATION_LIMITS.planBytes) throw new Error("Aggregate migration plan byte budget exceeded");
    events.push(input); item(kind, id, "accepted", collisions.length ? "Already committed; retry is idempotent" : "Consistent legacy record"); return true;
  };
  const accepted = new Set<string>();
  for (const [id, records] of observations) {
    try {
      if (records.length !== 1) throw new Error("Duplicate ledger ID requires resolution");
      const o = records[0], matches = db.rows.observations.filter(r => r.observation_id === id);
      if (matches.length !== 1) throw new Error("Missing or ambiguous database observation");
      const r = matches[0];
      if (o.text !== r.text || o.category !== r.category || o.timestamp !== r.timestamp) throw new Error("Ledger/database conflict");
      report.matchingDatabase++;
      if (!text(o.text).trim() || Buffer.byteLength(text(o.text)) > 16384 || !["decision", "constraint", "failed_approach", "relationship", "unresolved_work", "operational_knowledge", "other"].includes(text(o.category))) throw new Error("Unsupported observation text/category");
      const support = provenance(o, db.rows);
      const expected = [...support.evidenceIds.map(evidenceId => [evidenceId, null]), ...support.queryIds.map(queryId => [support.provenance.queries.find(q => q.queryId === queryId)!.evidenceId, queryId])].map(stable).sort();
      const actual = db.rows.observation_evidence.filter(l => l.observation_id === id).map(l => stable([l.evidence_id, l.query_id])).sort();
      if (stable(expected) !== stable(actual)) throw new Error("Ledger/database link conflict");
      if (propose("observation", id, date(o.timestamp), { text: o.text, category: o.category, ...support })) accepted.add(id);
    } catch (e) { item("observation", id, "unresolved", (e as Error).message); }
  }
  for (const o of db.rows.observations) if (!observations.has(String(o.observation_id))) {
    report.databaseOnly++; item("observation", String(o.observation_id), "skipped", "Database-only observation is not a committed ledger record");
  }
  for (const l of db.rows.observation_evidence) if (!db.rows.observations.some(o => o.observation_id === l.observation_id)) item("link", String(l.observation_id), "skipped", "Orphan database link");
  for (const c of [...db.rows.artifact_candidates].sort((a, b) => String(a.candidate_id).localeCompare(String(b.candidate_id)))) {
    try {
      const id = bare(c.candidate_id), observationId = bare(c.observation_id);
      if (!accepted.has(observationId)) { item("candidate", id, "skipped", "Orphan or unresolved supporting observation"); continue; }
      if (db.rows.artifact_candidates.filter(r => r.candidate_id === id).length !== 1 || c.status !== "candidate" || !["repo", "architecture", "organization"].includes(text(c.scope))) throw new Error("Unsupported or conflicting legacy candidate");
      propose("candidate", id, date(c.timestamp), { observationId, scope: c.scope, target: text(c.target), rationale: text(c.rationale), legacyStatus: "candidate" });
    } catch (e) { item("candidate", String(c.candidate_id), "unresolved", (e as Error).message); }
  }
  if (planBytes > MIGRATION_LIMITS.planBytes) throw new Error("Aggregate migration plan byte budget exceeded");
  return { report, events };
}
/** Pure read of the selected worktree and existing events; never initializes storage or projections. */
export async function dryRunLegacyMigration(identity: ContextOutIdentity): Promise<MigrationReport> { return (await plan(identity)).report; }
/** Explicit import recomputes the bounded plan. Partial commits are durable; retry this API after interruption.
 * A process crash can leave the event writer lock: verify the old owner has stopped before operator removal.
 */
export async function importLegacyMigration(identity: ContextOutIdentity, options: ContextOutWriterOptions = {}): Promise<MigrationReport> {
  const { report, events } = await plan(identity); report.mode = "import";
  if (!events.length) return report;
  const writer = await openContextOutEventWriter(identity, session(identity), options);
  try { for (const event of events) { await writer.append(event); report.committed++; } }
  finally { await writer.close(); }
  return report;
}
