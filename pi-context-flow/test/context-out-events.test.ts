import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, appendFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContextOutIdentity } from "../src/context-out/identity.js";
import { execFileSync } from "node:child_process";
import { ContextOutCommitUncertainError, ContextOutCorruptEventError, ContextOutLockedError, ContextOutRetryConflictError,
  MAX_CONTEXT_OUT_EVENT_BYTES, openContextOutEventWriter, replayContextOutEvents, type ContextOutEventInput } from "../src/context-out/events.js";

const input = (key: string): ContextOutEventInput => ({ idempotencyKey: key, subjectId: "obs-1", type: "observation.created",
  metadata: { branch: null, branchState: "detached", revision: "abc123", workingTree: "dirty" }, payload: { text: "same conclusion", evidence: [] } });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "context-out-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  return resolveContextOutIdentity(root, { home: join(root, "home") });
}

test("immutable provenance, serialized appends, distinct keys and sessions never deduplicate text", async t => {
  const identity = await fixture(t);
  const a = await openContextOutEventWriter(identity, "session/a");
  const b = await openContextOutEventWriter(identity, "session/b");
  const mutable = { ...input("first"), payload: { text: "original" } };
  const pending = a.append(mutable); mutable.payload.text = "changed";
  const first = await pending;
  assert.deepEqual(first.payload, { text: "original" });
  assert.equal(first.origin.worktreeId, identity.worktreeId);
  assert.equal(first.metadata.workingTree, "dirty");
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.payload) && Object.isFrozen(first.origin));
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).append(input(`key-${i}`))));
  await Promise.all([a.close(), b.close()]);
  const replay = await replayContextOutEvents(identity);
  assert.equal(replay.records.length, 21); assert.equal(replay.incompleteTails.length, 0);
  assert.deepEqual(await replayContextOutEvents(identity), replay);
});

test("exclusive session lock, deterministic retries across reopen, fresh shards and collisions", async t => {
  const identity = await fixture(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => openContextOutEventWriter(identity, "resume")));
  const winners = outcomes.filter(o => o.status === "fulfilled"); assert.equal(winners.length, 1);
  for (const o of outcomes) if (o.status === "rejected") assert.ok(o.reason instanceof ContextOutLockedError);
  const writer = winners[0].value;
  const first = await writer.append(input("retry"));
  assert.deepEqual(await writer.append(input("retry")), first);
  await assert.rejects(writer.append({ ...input("retry"), payload: { text: "conflict" } }), ContextOutRetryConflictError);
  await writer.close(); await assert.rejects(writer.append(input("closed")), /closed/);
  const resumed = await openContextOutEventWriter(identity, "resume");
  assert.deepEqual(await resumed.append(input("retry")), first);
  const next = await resumed.append(input("next"));
  assert.notEqual(next.writerId, first.writerId); assert.equal(next.sequence, 1);
  await resumed.close();
  assert.equal((await replayContextOutEvents(identity)).records.length, 2);
});

test("incomplete tails are reported and never appended to; complete corruption fails closed", async t => {
  const identity = await fixture(t);
  const writer = await openContextOutEventWriter(identity, "tail");
  await writer.append(input("one")); await writer.close();
  const record = (await replayContextOutEvents(identity)).records[0];
  await appendFile(record.path, '{"version":');
  const degraded = await replayContextOutEvents(identity);
  assert.deepEqual(degraded.incompleteTails, [{ path: record.path, offset: record.endOffset, bytes: 11 }]);
  const resumed = await openContextOutEventWriter(identity, "tail");
  await resumed.append(input("two")); await resumed.close();
  assert.equal((await replayContextOutEvents(identity)).records.length, 2);
  await appendFile(record.path, "\n");
  await assert.rejects(replayContextOutEvents(identity), ContextOutCorruptEventError);
  await assert.rejects(openContextOutEventWriter(identity, "tail"), ContextOutCorruptEventError);
});

test("rejects unsupported schema, altered provenance, sequence, invalid UTF-8 and oversized complete records", async t => {
  const identity = await fixture(t);
  const writer = await openContextOutEventWriter(identity, "corrupt");
  await writer.append(input("one")); await writer.close();
  const record = (await replayContextOutEvents(identity)).records[0];
  const original = await readFile(record.path, "utf8");
  const e = JSON.parse(original);
  for (const bad of [{ ...e, version: 2 }, { ...e, sequence: 3 }, { ...e, origin: { ...e.origin, repositoryId: "other" } }]) {
    await writeFile(record.path, JSON.stringify(bad) + "\n");
    await assert.rejects(replayContextOutEvents(identity), ContextOutCorruptEventError);
  }
  await writeFile(record.path, Buffer.from([0xff, 10]));
  await assert.rejects(replayContextOutEvents(identity), ContextOutCorruptEventError);
  await writeFile(record.path, "x".repeat(MAX_CONTEXT_OUT_EVENT_BYTES) + "\n");
  await assert.rejects(replayContextOutEvents(identity), ContextOutCorruptEventError);
});

test("bounds and invalid JSON fail before any new record", async t => {
  const identity = await fixture(t);
  const writer = await openContextOutEventWriter(identity, "bounds");
  await assert.rejects(writer.append({ ...input("large"), payload: "x".repeat(MAX_CONTEXT_OUT_EVENT_BYTES) }), /budget/);
  await assert.rejects(writer.append({ ...input("nan"), payload: NaN }), /JSON/);
  await assert.rejects(writer.append({ ...input("bad-meta"), metadata: { ...input("x").metadata, branch: "main" } }), /Inconsistent/);
  assert.equal((await replayContextOutEvents(identity)).records.length, 0);
  await writer.close();
});

for (const stage of ["beforeAppend", "afterAppend", "afterSync"] as const) {
  test(`uncertain ${stage} failure recovers by same key without duplicates`, async t => {
    const identity = await fixture(t);
    let fail = true;
    const writer = await openContextOutEventWriter(identity, "fault", { fault(s) { if (s === stage && fail) { fail = false; throw new Error("injected I/O failure"); } } });
    await assert.rejects(writer.append(input("retry")), error => error instanceof ContextOutCommitUncertainError && error.idempotencyKey === "retry" && /same idempotency key/.test(error.message));
    const recovered = await writer.append(input("retry"));
    await writer.close();
    const reopened = await openContextOutEventWriter(identity, "fault");
    assert.deepEqual(await reopened.append(input("retry")), recovered);
    await reopened.close();
    assert.equal((await replayContextOutEvents(identity)).records.length, 1);
  });
}
