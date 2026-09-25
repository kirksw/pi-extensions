import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, appendFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContextOutIdentity } from "../src/context-out/identity.js";
import { openContextOutEventWriter, replayContextOutEvents, type ContextOutEventInput } from "../src/context-out/events.js";
import { openContextOutProjection } from "../src/context-out/projection.js";
import { prepareObservationEvent } from "../src/context-out/provenance.js";
import { ContextStore } from "../src/store.js";

const metadata: ContextOutEventInput["metadata"] = { branch: "main", branchState: "unborn", revision: null, workingTree: "dirty" };
const creation = (subjectId: string, text = subjectId): ContextOutEventInput => ({ subjectId, idempotencyKey: subjectId,
  type: "observation.created", metadata, payload: { text, category: "decision", evidenceIds: [], queryIds: [],
    provenance: { evidence: [], queries: [] }, support: "unsupported" } });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "context-out-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  return resolveContextOutIdentity(root, { home: join(root, "home") });
}

test("prepared payload, lifecycle CAS, support, terminal history and candidates rebuild identically", async t => {
  const identity = await fixture(t), writer = await openContextOutEventWriter(identity, "session");
  const store = new ContextStore(identity.worktreeRoot);
  const prepared = await prepareObservationEvent(store, identity, { observationId: "a", idempotencyKey: "a", text: "prepared claim",
    category: "decision", evidenceIds: [], queryIds: [] });
  const a = await writer.append(prepared), b = await writer.append(creation("b")), c = await writer.append(creation("c"));
  const linked = await writer.append({ ...creation("a"), idempotencyKey: "link", type: "support.linked",
    payload: { predecessorEventId: a.eventId, observationId: "b" } });
  await writer.append({ ...creation("a"), idempotencyKey: "supersede", type: "observation.superseded",
    payload: { predecessorEventId: linked.eventId, replacementObservationId: "c" } });
  await writer.append({ ...creation("b"), idempotencyKey: "retract", type: "observation.retracted", payload: { predecessorEventId: b.eventId, reason: "wrong" } });
  await writer.append({ ...creation("candidate"), type: "candidate.proposed", payload: { observationId: "c", scope: "repo", target: "notes.md", rationale: "useful" } });
  await writer.close();
  const p = await openContextOutProjection(identity); t.after(() => p.close());
  assert.deepEqual((await p.search()).results.map(o => o.observationId), ["c"]);
  const read = (await p.read("observation://a")).results[0];
  assert.equal(read.state, "superseded"); assert.deepEqual(read.supportObservationIds, ["b"]); assert.equal(read.support, "unverified");
  assert.equal((await p.candidates()).results[0].status, "proposed");
  assert.equal((await p.issues()).results.length, 0);
  const before = await p.search({ history: true });
  await Promise.all([p.refresh(), p.refresh(), p.rebuild()]);
  assert.deepEqual(await p.search({ history: true }), before);
  const other = await openContextOutProjection(identity); assert.notEqual(other.path, p.path);
  assert.deepEqual(await other.search({ history: true }), before); await other.close(); await other.close();
  await assert.rejects(other.search(), /closed/); assert.equal(c.subjectId, "c");
});

test("competing successors never use timestamps; invalid ownership and unresolved references stay explicit", async t => {
  const identity = await fixture(t), w = await openContextOutEventWriter(identity, "owner");
  const a = await w.append(creation("a")); await w.append(creation("b"));
  for (const key of ["left", "right"]) await w.append({ ...creation("a"), idempotencyKey: key, type: "observation.retracted", payload: { predecessorEventId: a.eventId } });
  await w.append({ ...creation("b"), idempotencyKey: "missing", type: "support.linked", payload: { predecessorEventId: "absent", observationId: "a" } });
  await w.append({ ...creation("b"), idempotencyKey: "missing-ref", type: "support.linked", payload: { predecessorEventId: a.eventId, observationId: "absent" } });
  await w.append({ ...creation("bad"), payload: { text: "old incorrect shape", evidence: [] } });
  await w.close();
  const foreign = await openContextOutEventWriter({ ...identity, cloneId: "foreign-clone", worktreeId: "foreign-worktree" }, "foreign");
  await foreign.append(creation("foreign"));
  await foreign.append({ ...creation("a"), idempotencyKey: "attack", type: "observation.retracted", payload: { predecessorEventId: a.eventId } });
  await foreign.close();
  const p = await openContextOutProjection(identity); t.after(() => p.close());
  assert.equal((await p.read("a")).results[0].state, "conflict");
  const issues = await p.issues({ scope: "repository" });
  assert.equal(issues.results.filter(i => i.kind === "conflict").length, 2);
  assert.equal(issues.results.filter(i => i.kind === "unresolved").length, 2);
  assert.equal(issues.results.filter(i => i.kind === "invalid").length, 2);
  assert.equal((await p.read("foreign")).results.length, 0);
  assert.equal((await p.read("foreign", { scope: "repository" })).results.length, 1);
  assert.equal((await p.search()).complete, false);
});

test("strict source collisions/corruption fail transactionally and incomplete tails degrade coverage", async t => {
  const identity = await fixture(t), w = await openContextOutEventWriter(identity, "s");
  await w.append(creation("a")); await w.close();
  const p = await openContextOutProjection(identity); t.after(() => p.close());
  const r = (await replayContextOutEvents(identity)).records[0], bytes = await readFile(r.path);
  await appendFile(r.path, '{"partial":');
  assert.equal((await p.refresh()).incompleteTails, 1);
  assert.equal((await p.search()).complete, false);
  await writeFile(r.path, bytes); await p.refresh();
  const event = JSON.parse(bytes.toString()); event.sequence = 2;
  await appendFile(r.path, JSON.stringify(event) + "\n");
  await assert.rejects(p.refresh(), /Invalid complete event/);
  assert.equal((await p.read("a")).coverage.source, "error");
  await writeFile(r.path, bytes); await p.refresh();
  event.sequence = 1; event.timestamp = "2000-01-01T00:00:00Z";
  await writeFile(r.path, JSON.stringify(event) + "\n");
  await assert.rejects(p.rebuild(), /changed or disappeared/);
  assert.equal((await p.read("a")).results.length, 1);
});

test("bounded lexical pages, late matches, response limits, stale cursors and explicit history", async t => {
  const identity = await fixture(t), w = await openContextOutEventWriter(identity, "s");
  for (let i = 0; i < 6; i++) await w.append(creation(`o${i}`, i === 5 ? "late needle" : "ordinary"));
  const p = await openContextOutProjection(identity); t.after(() => p.close());
  const first = await p.search({ query: "needle", scanLimit: 2 });
  assert.equal(first.scanned, 2); assert.equal(first.results.length, 0); assert.equal(first.stopReason, "scan");
  const second = await p.search({ query: "needle", scanLimit: 2, cursor: first.nextCursor });
  const third = await p.search({ query: "needle", scanLimit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.results.map(o => o.observationId), ["o5"]); assert.equal(third.complete, true);
  const page = await p.search({ limit: 2 }); assert.equal(page.results.length, 2);
  assert.deepEqual((await p.search({ limit: 2, cursor: page.nextCursor })).results.map(o => o.observationId), ["o2", "o3"]);
  await assert.rejects(p.search({ query: "x".repeat(1025) }), /budget/);
  await assert.rejects(p.search({ scanLimit: 1001 }), /budget/);
  await assert.rejects(p.search({ cursor: page.nextCursor, history: true }), /cursor/);
  await w.append(creation("large", "x".repeat(16000))); await p.refresh();
  await assert.rejects(p.search({ cursor: page.nextCursor }), /cursor/);
  const bounded = await p.read("large", { responseBytes: 8192 });
  assert.equal(bounded.results.length, 1); assert.equal((bounded.results[0] as unknown as { truncated: boolean }).truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 8192);
  assert.equal((await p.read("large")).results.length, 1);
  await w.close();
});

test("later creation resolves references, subject/candidate collisions expose no winner, history stays scoped", async t => {
  const identity = await fixture(t), w = await openContextOutEventWriter(identity, "s");
  const a = await w.append(creation("a"));
  await w.append({ ...creation("a"), idempotencyKey: "link", type: "support.linked", payload: { predecessorEventId: a.eventId, observationId: "later" } });
  const p = await openContextOutProjection(identity); t.after(() => p.close());
  assert.equal((await p.issues()).results[0].kind, "unresolved");
  await w.append(creation("later")); await p.refresh();
  assert.equal((await p.issues()).results.length, 0);
  assert.deepEqual((await p.read("a")).results[0].supportObservationIds, ["later"]);
  const history = await p.history();
  assert.equal(history.results.length, 3);
  assert.deepEqual(history.results.find(e => e.eventId === a.eventId)?.payload, a.payload);
  for (const key of ["proposal1", "proposal2"]) await w.append({ ...creation("candidate"), idempotencyKey: key, type: "candidate.proposed",
    payload: { observationId: "later", scope: "architecture", target: "doc", rationale: key } });
  await w.append({ ...creation("a"), idempotencyKey: "duplicate-subject" });
  await w.close(); await p.refresh();
  assert.equal((await p.read("a")).results.length, 0);
  assert.equal((await p.candidates()).results.length, 0);
  assert.equal((await p.issues()).results.filter(i => i.kind === "conflict").length, 4);
});

test("historical query snapshots with evidence URIs project without rewriting events", async t => {
  const identity = await fixture(t), writer = await openContextOutEventWriter(identity, "s");
  const input = creation("uri-history");
  const payload = { text: "Historical claim", category: "other", evidenceIds: [], queryIds: ["q"], support: "unverified",
    provenance: { evidence: [{ evidenceId: "e", tool: "fixture", timestamp: "now", source: "fixture", shape: "json", sha256: "a".repeat(64), sizeBytes: 1, coverage: "unknown", dependencies: [] }],
      queries: [{ queryId: "q", evidenceId: "evidence://e", language: "sql", query: "SELECT * FROM evidence", timestamp: "now", outputEvidenceId: null }] } };
  await writer.append({ ...input, payload }); await writer.close();
  const before = await replayContextOutEvents(identity);
  const p = await openContextOutProjection(identity); t.after(() => p.close());
  assert.equal((await p.read("uri-history")).results.length, 1);
  assert.deepEqual(await replayContextOutEvents(identity), before);
});

test("oversized matching rows advance cursors and leave later claims reachable", async t => {
  const identity = await fixture(t), writer = await openContextOutEventWriter(identity, "budget");
  for (const [key, text] of [["a", "small"], ["b", "\\".repeat(12000)], ["c", "later"]]) await writer.append(creation(key, text));
  await writer.close();
  const projection = await openContextOutProjection(identity); t.after(() => projection.close());
  const first = await projection.search({ responseBytes: 24000 });
  assert.deepEqual(first.results.map(o => o.observationId), ["a"]);
  const second = await projection.search({ responseBytes: 24000, cursor: first.nextCursor });
  assert.deepEqual(second.results.map(o => o.observationId), ["b", "c"]);
  assert.equal(second.scanComplete, true);
  assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 24000);
});

test("long historical identifiers cannot overflow previews or cursor budgets", async t => {
  const identity = await fixture(t), writer = await openContextOutEventWriter(identity, "long-ids");
  const longId = "b".repeat(4096);
  await writer.append(creation(longId, "\u0001".repeat(11000)));
  await writer.append(creation("z", "later")); await writer.close();
  const projection = await openContextOutProjection(identity); t.after(() => projection.close());
  const first = await projection.search({ responseBytes: 8192, limit: 1 });
  assert.equal(first.results[0].observationId, longId);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 8192);
  const second = await projection.search({ responseBytes: 8192, limit: 1, cursor: first.nextCursor });
  assert.equal(second.results[0].observationId, "z");
  assert.equal(second.scanComplete, true);
});
