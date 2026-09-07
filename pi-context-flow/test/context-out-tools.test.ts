import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, unlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register from "../src/index.js";
import { ContextOutStore } from "../src/context-out/store.js";
import { replayContextOutEvents } from "../src/context-out/events.js";
import { resolveContextOutIdentity } from "../src/context-out/identity.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "context-out-tools-")), repo = join(root, "repo"), home = join(root, "home");
  await mkdir(repo); execFileSync("git", ["init", "-q", repo]);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
  return { root, repo, home, git };
}
function harness(home: string, service?: ContextOutStore) {
  const tools = new Map<string, any>(), handlers = new Map<string, any>();
  register({ registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, callback: any) { handlers.set(name, callback); } } as never, { home, contextOut: service });
  return {
    async call(name: string, params: unknown, cwd: string, session = "session-real-1", id = name) {
      const result = await tools.get(name).execute(id, params, undefined, undefined, { cwd, sessionManager: { getSessionId: () => session } });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
      return JSON.parse(result.content[0].text);
    },
    close: () => handlers.get("session_shutdown")(),
    tools,
  };
}
const claim = { text: "Use transactional writes", category: "decision", evidenceIds: [], queryIds: [] };

test("registered tools commit with real sessions, semantic retry before provenance, and lifecycle CAS", async () => {
  const { repo, home, git } = await fixture(), h = harness(home);
  try {
    const capture = await h.tools.get("context_capture").execute("capture", { tool: "fixture", arguments: {}, payload: [{ x: 1 }] }, undefined, undefined, { cwd: repo });
    const evidenceId = capture.details.evidence.evidenceId;
    const input = { ...claim, evidenceIds: [`evidence://${evidenceId}`] };
    const created = await h.call("context_observe", input, repo);
    assert.equal(created.committed, true);
    const read = await h.call("context_read_observation", { observationId: created.observationId, assess: true }, repo);
    assert.equal(read.results[0].sessionId, "session-real-1");
    assert.equal(read.supportAssessment.status, "available");
    assert.equal(read.supportAssessment.assessments[0].coverage, "unknown");
    git("checkout", "-b", "changed");
    await unlink(join(repo, ".pi/context/evidence/raw", `${evidenceId}.json`));
    assert.equal((await h.call("context_observe", input, repo)).eventId, created.eventId);
    await assert.rejects(h.call("context_observe", { ...input, text: "different" }, repo), /semantic request/);
    const retryRead = await h.call("context_read_observation", { observationId: created.observationId, assess: true }, repo);
    assert.equal(retryRead.results[0].metadata.branch, read.results[0].metadata.branch);
    assert.equal(retryRead.supportAssessment.status, "unavailable");
    await assert.rejects(h.call("context_observe", { ...claim, evidenceIds: ["missing"] }, repo, "session-real-1", "bad"), /Unknown evidence/);
    await assert.rejects(h.call("context_observe", { ...claim, queryIds: ["missing"] }, repo, "session-real-1", "bad-query"), /Unknown query/);
    const second = await h.call("context_observe", claim, repo, "fork-session");
    assert.notEqual(second.observationId, created.observationId);
    const candidate = await h.call("context_promote", { observationId: created.observationId, scope: "repo", target: "AGENTS.md", rationale: "Useful" }, repo);
    assert.equal(candidate.status, "proposed");
    assert.equal((await h.call("context_candidate_inbox", {}, repo)).results.length, 1);
    await assert.rejects(access(join(repo, "AGENTS.md")));
    const linked = await h.call("context_observation_lifecycle", { observationId: created.observationId, predecessorEventId: created.eventId, action: "link_support", relatedObservationId: second.observationId }, repo);
    const retracted = await h.call("context_observation_lifecycle", { observationId: created.observationId, predecessorEventId: linked.eventId, action: "retract" }, repo, "session-real-1", "retract");
    assert.equal(retracted.committed, true);
    await assert.rejects(h.call("context_observation_lifecycle", { observationId: created.observationId, predecessorEventId: linked.eventId, action: "retract" }, repo, "session-real-1", "stale"), /current predecessor/);
    assert.equal((await h.call("context_search_observations", {}, repo)).results.length, 1);
    assert.equal((await h.call("context_search_observations", { history: true }, repo)).results.length, 2);
    const inspect = await h.call("context_inspect_observation", { observationId: created.observationId, section: "provenance" }, repo);
    assert.match(inspect.chunk, /sha256/);
  } finally { await h.close(); }
  const resumed = harness(home);
  try { assert.equal((await resumed.call("context_search_observations", { history: true }, repo)).results.length, 2); }
  finally { await resumed.close(); }
});

test("linked worktree deletion preserves claims with explicit scope and missing-origin support", async () => {
  const { root, repo, home, git } = await fixture(), linked = join(root, "linked"), h = harness(home);
  git("worktree", "add", "-b", "linked", linked);
  let created: any;
  try {
    const capture = await h.tools.get("context_capture").execute("capture", { tool: "fixture", arguments: {}, payload: "INFO evidence" }, undefined, undefined, { cwd: linked });
    created = await h.call("context_observe", { ...claim, evidenceIds: [capture.details.evidence.evidenceId] }, linked);
    assert.equal((await h.call("context_search_observations", {}, repo)).results.length, 0);
    assert.equal((await h.call("context_read_observation", { observationId: created.observationId }, repo)).results.length, 0);
    assert.equal((await h.call("context_read_observation", { observationId: created.observationId, scope: "repository", assess: true }, repo)).supportAssessment.status, "unverified");
    await assert.rejects(h.call("context_promote", { observationId: created.observationId, scope: "repo", target: "AGENTS.md", rationale: "x" }, repo), /owned/);
  } finally { await h.close(); }
  git("worktree", "remove", "--force", linked);
  const survivor = harness(home);
  try {
    const result = await survivor.call("context_read_observation", { observationId: created.observationId, scope: "repository", assess: true }, repo);
    assert.equal(result.supportAssessment.status, "unavailable");
    assert.equal(result.results[0].text, claim.text);
  } finally { await survivor.close(); }
});

test("postcommit projection failures preserve IDs and retry; dry-run never creates legacy database", async () => {
  const { repo, home } = await fixture();
  let fail = true;
  const h = harness(home, new ContextOutStore({ home, afterCommit: async () => { if (fail) throw new Error("injected"); } }));
  try {
    const dry = await h.call("context_migrate_legacy", { mode: "dry-run" }, repo);
    assert.equal(dry.databasePresent, false);
    await assert.rejects(access(join(repo, ".pi/context/state.duckdb")));
    const first = await h.call("context_observe", claim, repo);
    assert.equal(first.committed, true); assert.match(first.warning, /projection/);
    fail = false;
    assert.equal((await h.call("context_observe", claim, repo)).observationId, first.observationId);
    const read = await h.call("context_read_observation", { observationId: first.observationId, assess: true }, repo);
    assert.equal(read.supportAssessment.status, "unsupported");
    const identity = await resolveContextOutIdentity(repo, { home });
    assert.equal((await replayContextOutEvents(identity)).records.length, 1);
  } finally { await h.close(); }
  await assert.rejects(h.call("context_search_observations", {}, repo), /shut down/);
});

test("integrity mismatches and mixed support report per-reference coverage", async () => {
  const { repo, home } = await fixture(), h = harness(home);
  try {
    const ids: string[] = [];
    for (const payload of ["INFO one", "INFO two"]) {
      const capture = await h.tools.get("context_capture").execute("capture", { tool: "fixture", arguments: {}, payload }, undefined, undefined, { cwd: repo }); ids.push(capture.details.evidence.evidenceId);
    }
    const created = await h.call("context_observe", { ...claim, evidenceIds: ids }, repo);
    await writeFile(join(repo, ".pi/context/evidence/raw", `${ids[0]}.txt`), "INFO bad");
    const result = await h.call("context_read_observation", { observationId: created.observationId, assess: true }, repo);
    assert.equal(result.supportAssessment.status, "partial");
    assert.deepEqual(result.supportAssessment.counts, { available: 1, unavailable: 1, unverified: 0 });
    assert.match(result.supportAssessment.assessments.find((a: any) => a.status === "unavailable").reason, /Integrity/);
  } finally { await h.close(); }
});

test("availability verifies evidence exactly at the declared byte budget", async () => {
  const { assessEvidence } = await import("../src/context-out/availability.js");
  const { createHash } = await import("node:crypto");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "context-out-cap-"));
  try {
    const raw = join(root, ".pi/context/evidence/raw"); await mkdir(raw, { recursive: true });
    const bytes = Buffer.alloc(8 * 1024 * 1024, 120); await writeFile(join(raw, "test.txt"), bytes);
    const identity = { cloneId: "clone", worktreeId: "worktree", worktreeRoot: root } as import("../src/context-out/identity.js").ContextOutIdentity;
    const results = await assessEvidence(identity, identity as unknown as import("../src/context-out/events.js").ContextOutEvent["origin"], [{ evidenceId: "test", sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, shape: "text", coverage: "unknown" }]);
    assert.equal(results[0].status, "available");
  } finally { await rm(root, { recursive: true, force: true }); }
});
