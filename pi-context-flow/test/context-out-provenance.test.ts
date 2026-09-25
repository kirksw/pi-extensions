import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextStore } from "../src/store.js";

test("observation provenance validates links and excludes raw payloads and arguments", async () => {
  const store = new ContextStore(await mkdtemp(join(tmpdir(), "context-out-provenance-")));
  await store.initialize();
  const evidence = await store.capture("tool", { password: "not-in-snapshot" }, [{ value: 1 }]);
  const query = await store.querySql(evidence.evidenceId, "SELECT count(*) AS count FROM evidence");
  const snapshot = await store.observationProvenance({ evidenceIds: [`evidence://${evidence.evidenceId}`], queryIds: [`query://${query.query.queryId}`] });
  assert.equal(snapshot.evidence.length, 1);
  assert.equal(snapshot.evidence[0].sha256, evidence.sha256);
  assert.equal(snapshot.queries[0].query, "SELECT count(*) AS count FROM evidence");
  assert.equal(snapshot.evidence[0].coverage, "unknown");
  assert.ok(!JSON.stringify(snapshot).includes("not-in-snapshot"));
  assert.ok(!JSON.stringify(snapshot).includes("rawPath"));
  await assert.rejects(store.observationProvenance({ evidenceIds: ["missing"], queryIds: [] }), /Unknown evidence/);
  await assert.rejects(store.observationProvenance({ evidenceIds: [], queryIds: ["missing"] }), /Unknown query/);
  await assert.rejects(store.observationProvenance({ evidenceIds: Array(129).fill(evidence.evidenceId), queryIds: [] }), /128/);
  assert.deepEqual(await store.observationProvenance({ evidenceIds: [], queryIds: [] }), { evidence: [], queries: [] });
});

test("observation preparation rejects invalid claims before returning commit payload", async () => {
  const { prepareObservation } = await import("../src/context-out/provenance.js");
  const store = new ContextStore(await mkdtemp(join(tmpdir(), "context-out-prepare-")));
  await store.initialize();
  const input = { text: "Useful conclusion", category: "decision" as const, evidenceIds: [], queryIds: [] };
  assert.equal((await prepareObservation(store, input)).support, "unsupported");
  await assert.rejects(prepareObservation(store, { ...input, text: " " }), /text/);
  await assert.rejects(prepareObservation(store, { ...input, evidenceIds: ["missing"] }), /Unknown evidence/);
});

test("origin snapshots label unborn and detached revisions without inventing branch names", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const { resolveContextOutIdentity } = await import("../src/context-out/identity.js");
  const { originSnapshot } = await import("../src/context-out/provenance.js");
  const root = await mkdtemp(join(tmpdir(), "context-out-origin-"));
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init");
  const identity = await resolveContextOutIdentity(repo, { home: join(root, "home") });
  const unborn = await originSnapshot(identity);
  assert.equal(unborn.headState, "unborn"); assert.equal(unborn.revision, null);
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "test");
  git("checkout", "--detach");
  const detached = await originSnapshot(identity);
  assert.equal(detached.headState, "detached"); assert.equal(detached.branch, null);
  assert.match(detached.revision!, /^[0-9a-f]{40,64}$/);
});

test("validated observation events commit only after local provenance is resolved", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  const { resolveContextOutIdentity } = await import("../src/context-out/identity.js");
  const { prepareObservationEvent } = await import("../src/context-out/provenance.js");
  const { openContextOutEventWriter, replayContextOutEvents } = await import("../src/context-out/events.js");
  const root = await mkdtemp(join(tmpdir(), "context-out-commit-"));
  const repo = join(root, "repo"); await mkdir(repo); execFileSync("git", ["init", "-q", repo]);
  const identity = await resolveContextOutIdentity(repo, { home: join(root, "home") });
  const store = new ContextStore(repo); await store.initialize();
  const writer = await openContextOutEventWriter(identity, "test-session");
  try {
    const input = { observationId: "observation://test", idempotencyKey: "key", text: "conclusion", category: "decision" as const, evidenceIds: ["missing"], queryIds: [] };
    await assert.rejects(prepareObservationEvent(store, identity, input), /Unknown evidence/);
    assert.equal((await replayContextOutEvents(identity)).records.length, 0);
    const evidence = await store.capture("test", {}, { value: 1 });
    const prepared = await prepareObservationEvent(store, identity, { ...input, evidenceIds: [evidence.evidenceId] });
    const event = await writer.append(prepared);
    assert.equal(event.subjectId, "test");
    assert.deepEqual(await writer.append(prepared), event);
    assert.equal((await replayContextOutEvents(identity)).records.length, 1);
    const other = join(root, "other"); await mkdir(other); execFileSync("git", ["init", "-q", other]);
    const otherStore = new ContextStore(other); await otherStore.initialize();
    await assert.rejects(prepareObservationEvent(otherStore, identity, input), /different worktree/);
  } finally { await writer.close(); }
});

test("workspace evidence locators reject traversal, absolute paths and symlink escapes", async t => {
  const { execFileSync } = await import("node:child_process");
  const { mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { assessEvidence, safeWorkspaceRelative } = await import("../src/context-out/availability.js");
  const { resolveContextOutIdentity } = await import("../src/context-out/identity.js");
  const root = await mkdtemp(join(tmpdir(), "context-out-locator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), outside = join(root, "outside"); await mkdir(repo); await mkdir(outside);
  execFileSync("git", ["init", "-q", repo]);
  const identity = await resolveContextOutIdentity(repo, { home: join(root, "home") });
  for (const path of ["../outside", "/outside", "a/../b", "a\\b", "C:/outside", "a\0b"]) assert.equal(safeWorkspaceRelative(path), false);
  const directory = join(outside, ".pi", "context", "evidence", "raw"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "e.json"), "{}"); await symlink(outside, join(repo, "escape"));
  const snapshots = [{ evidenceId: "e", shape: "json", sha256: createHash("sha256").update("{}").digest("hex"), sizeBytes: 2, coverage: "unknown", workspaceRelative: "escape" }];
  assert.equal((await assessEvidence(identity, identity, snapshots))[0].status, "unverified");
});
