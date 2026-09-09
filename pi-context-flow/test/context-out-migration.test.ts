import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import duckdb from "duckdb";
import { resolveContextOutIdentity } from "../src/context-out/identity.js";
import { dryRunLegacyMigration, importLegacyMigration, MIGRATION_LIMITS } from "../src/context-out/migration.js";
import { replayContextOutEvents } from "../src/context-out/events.js";
import { openContextOutProjection } from "../src/context-out/projection.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "context-out-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  return resolveContextOutIdentity(root, { home: join(root, "home") });
}
const timestamp = "2020-01-01T00:00:00.000Z";
const observation = (id: string, evidenceIds: string[] = [], queryIds: string[] = []) => ({ observationId: id, text: id, category: "decision", timestamp, evidenceIds, queryIds });
async function setup(root: string, sql: string, records: unknown[]) {
  const dir = join(root, ".pi/context"); await mkdir(join(dir, "observations"), { recursive: true });
  await writeFile(join(dir, "observations/ledger.jsonl"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  const db = await new Promise<duckdb.Database>((resolve, reject) => { const db = new duckdb.Database(join(dir, "state.duckdb"), e => e ? reject(e) : resolve(db)); });
  const c = db.connect();
  try {
    await new Promise<void>((resolve, reject) => c.exec(`
      CREATE TABLE observations(observation_id VARCHAR, text VARCHAR, category VARCHAR, timestamp VARCHAR);
      CREATE TABLE observation_evidence(observation_id VARCHAR, evidence_id VARCHAR, query_id VARCHAR);
      CREATE TABLE artifact_candidates(candidate_id VARCHAR, observation_id VARCHAR, scope VARCHAR, target VARCHAR, rationale VARCHAR, timestamp VARCHAR, status VARCHAR);
      CREATE TABLE evidence_queries(query_id VARCHAR, evidence_id VARCHAR, language VARCHAR, query_text VARCHAR, timestamp VARCHAR, output_evidence_id VARCHAR);
      CREATE TABLE evidence(evidence_id VARCHAR, tool VARCHAR, timestamp VARCHAR, source VARCHAR, size_bytes BIGINT, shape VARCHAR, sha256 VARCHAR, dependencies_json VARCHAR);
      ${sql}`, e => e ? reject(e) : resolve()));
  } finally { await new Promise<void>(r => c.close(() => r())); await new Promise<void>(r => db.close(() => r())); }
}
const insert = (id: string) => `INSERT INTO observations VALUES ('${id}', '${id}', 'decision', '${timestamp}');`;
async function files(root: string): Promise<string[]> { return (await readdir(root, { recursive: true })).sort(); }

test("dry-run is read-only; supported observations/candidates preserve legacy data and retry after uncertain commit", async t => {
  const identity = await fixture(t);
  await setup(identity.worktreeRoot, `${insert("a")}
    INSERT INTO evidence VALUES ('e', 'tool', '${timestamp}', 'source', 12, 'json', '${"a".repeat(64)}', '[]');
    INSERT INTO evidence_queries VALUES ('q', 'e', 'sql', 'select * from evidence', '${timestamp}', NULL);
    INSERT INTO observation_evidence VALUES ('a', 'e', NULL), ('a', 'e', 'q');
    INSERT INTO artifact_candidates VALUES ('c', 'a', 'repo', 'notes.md', 'useful', '${timestamp}', 'candidate');`, [observation("a", ["e"], ["q"])]);
  const paths = [join(identity.worktreeRoot, ".pi/context/state.duckdb"), join(identity.worktreeRoot, ".pi/context/observations/ledger.jsonl")];
  const before = await Promise.all(paths.map(p => readFile(p))), listing = await files(identity.worktreeRoot);
  const dry = await dryRunLegacyMigration(identity);
  assert.equal(dry.accepted, 2); assert.equal(dry.unresolved, 0);
  assert.deepEqual(await files(identity.worktreeRoot), listing);
  assert.equal((await replayContextOutEvents(identity)).records.length, 0);
  let injected = false;
  await assert.rejects(importLegacyMigration(identity, { fault(stage) { if (!injected && stage === "afterSync") { injected = true; throw new Error("crash"); } } }), /uncertain/);
  await importLegacyMigration(identity); await importLegacyMigration(identity);
  const replay = await replayContextOutEvents(identity); assert.equal(replay.records.length, 2);
  for (const { event } of replay.records) {
    assert.equal(event.metadata.branchState, "unknown"); assert.equal(event.metadata.revision, null);
    const migration = (event.payload as Record<string, any>).migration;
    assert.equal(migration.originalId, event.subjectId); assert.equal(migration.originalTimestamp, timestamp);
    assert.equal(migration.historicalSession, null); assert.match(migration.sessionRole, /not-historical/);
  }
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p))), before);
  const projection = await openContextOutProjection(identity);
  try { assert.equal((await projection.issues()).results.length, 0); assert.equal((await projection.search()).results.length, 1); assert.equal((await projection.candidates()).results[0].status, "proposed"); }
  finally { await projection.close(); }
});

test("conflicts, database-only, malformed, orphans and broken lineage remain unresolved or skipped", async t => {
  const identity = await fixture(t);
  await setup(identity.worktreeRoot, `${insert("conflict")}${insert("broken")}${insert("db-only")}${insert("links")}${insert("ok")}
    INSERT INTO observation_evidence VALUES ('broken', 'absent', NULL), ('ghost', 'absent', NULL);
    INSERT INTO artifact_candidates VALUES ('orphan', 'db-only', 'repo', 'x', 'x', '${timestamp}', 'candidate');`,
  [{ ...observation("conflict"), text: "disagrees" }, observation("broken", ["absent"]), observation("links", [], ["missing-query"]), observation("ok"), null]);
  const report = await importLegacyMigration(identity);
  assert.equal(report.databaseOnly, 1); assert.equal(report.malformed, 1); assert.equal(report.accepted, 1);
  assert.equal(report.unresolved, 4); assert.equal(report.skipped, 3);
  assert.equal((await replayContextOutEvents(identity)).records.length, 1);
});

test("missing database is permitted without creation; ledger and report budgets are explicit", async t => {
  const identity = await fixture(t), dir = join(identity.worktreeRoot, ".pi/context/observations");
  const empty = await dryRunLegacyMigration(identity); assert.equal(empty.databasePresent, false);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ledger.jsonl"), Array.from({ length: 200 }, (_, i) => JSON.stringify(observation(`o${i}`))).join("\n") + "\n");
  const before = await files(identity.worktreeRoot), report = await importLegacyMigration(identity);
  assert.equal(report.unresolved, 200); assert.equal(report.items.length, 100); assert.equal(report.omittedItems, 100);
  assert.deepEqual(await files(identity.worktreeRoot), before);
  await writeFile(join(dir, "ledger.jsonl"), "x".repeat(MIGRATION_LIMITS.ledgerBytes + 1));
  await assert.rejects(dryRunLegacyMigration(identity), /input budget/);
  assert.equal((await replayContextOutEvents(identity)).records.length, 0);
});

test("changed legacy payload conflicts with committed migration; duplicate IDs and dependency cycles do not import", async t => {
  const identity = await fixture(t);
  await setup(identity.worktreeRoot, `${insert("a")}${insert("duplicate")}${insert("cycle")}
    INSERT INTO evidence VALUES ('e', 'tool', '${timestamp}', 'source', 12, 'json', '${"a".repeat(64)}', '["e"]');
    INSERT INTO observation_evidence VALUES ('cycle', 'e', NULL);`,
  [observation("a"), observation("duplicate"), observation("duplicate"), observation("cycle", ["e"])]);
  const first = await importLegacyMigration(identity); assert.equal(first.accepted, 1); assert.equal(first.unresolved, 2);
  // Recreate the legacy DB after its read-only migration handles have explicitly closed.
  const path = join(identity.worktreeRoot, ".pi/context/state.duckdb");
  const db = await new Promise<duckdb.Database>((resolve, reject) => { const db = new duckdb.Database(path, e => e ? reject(e) : resolve(db)); });
  await new Promise<void>((resolve, reject) => db.exec("UPDATE observations SET text = 'changed' WHERE observation_id = 'a'", e => e ? reject(e) : resolve()));
  await new Promise<void>(r => db.close(() => r()));
  await writeFile(join(identity.worktreeRoot, ".pi/context/observations/ledger.jsonl"), JSON.stringify({ ...observation("a"), text: "changed" }) + "\n");
  const changed = await importLegacyMigration(identity);
  assert.equal(changed.accepted, 0); assert.ok(changed.items.some(i => /committed Context Out/.test(i.reason)));
  assert.equal((await replayContextOutEvents(identity)).records.length, 1);
});
