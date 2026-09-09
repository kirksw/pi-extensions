import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import { reviewProcess } from "./helpers/review-process.js";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "context-review-"));
  const workers: ReturnType<typeof reviewProcess>[] = [];
  t.after(async () => { await Promise.all(workers.map((worker) => worker.stop())); await rm(cwd, { recursive: true, force: true }); });
  return { cwd, worker(env?: NodeJS.ProcessEnv) { const worker = reviewProcess(cwd, env); workers.push(worker); return worker; } };
}
const jq = process.env.PATH?.split(delimiter).some((path) => existsSync(join(path, "jq")));

test("review: isolated capture/schema/SQL/read and process restart retain evidence", async (t) => {
  const h = await fixture(t), first = h.worker();
  await first.call({ op: "init" });
  const { evidenceId: id } = await first.call({ op: "capture" });
  assert.equal((await first.call({ op: "schema", id })).rowCount, 1);
  assert.deepEqual((await first.call({ op: "sql", id })).rows, [{ values: [1, 2] }]);
  assert.deepEqual((await first.call({ op: "read", id })).value, [1, 2]);
  await first.stop();
  const resumed = h.worker(); await resumed.call({ op: "init" });
  assert.deepEqual((await resumed.call({ op: "read", id })).value, [1, 2]);
});

test("review: same-worktree concurrent processes can capture without native lock failure", async (t) => {
  const h = await fixture(t), first = h.worker(), second = h.worker();
  await first.call({ op: "init" });
  await first.call({ op: "capture" });
  await second.call({ op: "init" });
  const { evidenceId: id } = await second.call({ op: "capture" });
  assert.deepEqual((await first.call({ op: "read", id })).value, [1, 2]);
  const captured = await Promise.all([first.call({ op: "capture" }), second.call({ op: "capture" })]);
  assert.notEqual(captured[0].evidenceId, captured[1].evidenceId);
  assert.deepEqual((await second.call({ op: "read", id: captured[0].evidenceId })).value, [1, 2]);
  assert.deepEqual((await first.call({ op: "read", id: captured[1].evidenceId })).value, [1, 2]);
});

test("review: registered shutdown releases Context In while old process remains alive", async (t) => {
  const h = await fixture(t), first = h.worker();
  const captured = await first.call({ op: "hookCapture" });
  await first.call({ op: "shutdown" });
  const reloaded = h.worker(); await reloaded.call({ op: "init" });
  assert.deepEqual((await reloaded.call({ op: "read", id: captured.details.evidence.evidenceId })).value, [1, 2]);
});

for (const [name, expression, expected] of [
  ["mixed documents and escaped delimiters", 'null, true, -2, "a \\"quoted\\" } [", {nested: [1, {x: "line\\ntext"}]}', [null, true, -2, 'a "quoted" } [', {nested: [1, {x: "line\ntext"}]}]],
  ["single result compatibility", ".values", [1, 2]],
  ["empty output compatibility", "empty", null],
  ["scalar document stream", ".values[]", [1, 2]],
  ["pretty object document stream", '.values[] | {value: ., nested: [., "line\\ntext"]}', [{ value: 1, nested: [1, "line\ntext"] }, { value: 2, nested: [2, "line\ntext"] }]],
] as const) test(`review: jq ${name}`, { skip: !jq && "missing jq CLI on PATH" }, async (t) => {
  const worker = (await fixture(t)).worker(); await worker.call({ op: "init" });
  const { evidenceId: id } = await worker.call({ op: "capture" });
  const result = await worker.call({ op: "jq", id, expression });
  assert.deepEqual(result.result, expected); assert.equal(result.truncated, false);
});

test("review: jq oversized stream stays bounded with retained evidence", { skip: !jq && "missing jq CLI on PATH" }, async (t) => {
  const worker = (await fixture(t)).worker(); await worker.call({ op: "init" });
  const { evidenceId: id } = await worker.call({ op: "capture" });
  const result = await worker.call({ op: "jq", id, expression: 'range(20000) | {value: .}' });
  assert.equal(result.truncated, true); assert.ok(result.outputEvidence);
  assert.ok(Buffer.byteLength(JSON.stringify(result.result)) < 100000);
});

test("review: container CLI discovered and executed from nonstandard PATH without secrets", async (t) => {
  const h = await fixture(t), bin = join(h.cwd, "nonstandard-bin"); await mkdir(bin);
  const script = `#!${process.execPath}\nif (process.env.REVIEW_FAKE_SECRET) process.exit(42);\nif (process.argv[2] === 'version') console.log('fixture-server');\nelse if (process.argv[2] === 'run') console.log('fixture-ok');\nelse process.exit(43);\n`;
  for (const name of ["docker", "podman"]) await writeFile(join(bin, name), script, { mode: 0o755 });
  const worker = h.worker({ PATH: bin, REVIEW_FAKE_SECRET: "synthetic-not-a-secret" });
  await worker.call({ op: "init" });
  const result = await worker.call({ op: "repl" });
  assert.equal(result.available, true, result.reason);
  assert.equal(result.exitCode, 0); assert.match(result.output, /fixture-ok/);
});
