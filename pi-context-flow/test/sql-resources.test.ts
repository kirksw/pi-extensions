import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ContextStore } from "../src/store.js";
import { analyzeSql, SQL_TIMEOUT_MS, SQL_MATERIALIZATION_BYTES } from "../src/sql-analysis.js";
const exec = promisify(execFile);

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "sql-resources-"));
  const store = new ContextStore(directory);
  await store.initialize();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await store.captureRaw("sql-test", {}, '{"items":[{"id":1,"owner":{"name":"Ada"}},{"id":2,"owner":{"name":"Grace"}}]}');
  return { directory, store, evidence };
}
async function assertNoWorkers() {
  const { stdout } = await exec("ps", ["-axo", "ppid=,command="]);
  assert.equal(stdout.split("\n").filter(line => Number(line.trim().split(/\s+/)[0]) === process.pid && line.includes("sql-worker.mjs")).length, 0);
}

test("nested SQL and authoritative schema survive isolation with native values", async t => {
  const { store, evidence } = await fixture(t);
  const result = await store.querySql(evidence.evidenceId, 'SELECT item.id, item.owner.name AS name FROM evidence, UNNEST(items) AS t(item) ORDER BY item.id');
  assert.deepEqual(result.rows, [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }]);
  assert.equal(result.truncated, false);
  const schema = await store.inspectSchema(evidence.evidenceId, { detail: "full" });
  assert.match(JSON.stringify(schema), /STRUCT/);
  const records = await store.queryRecords(evidence.evidenceId, { collectionHint: "items", select: ["id", "owner.name"], orderBy: [{ field: "id", direction: "asc" }], limit: 2 });
  assert.deepEqual(records.records, [{ id: 1, "owner.name": "Ada" }, { id: 2, "owner.name": "Grace" }]);
  await assertNoWorkers();
});

test("XML, YAML and delimited ingestion preserve structured query behavior", async t => {
  const { store } = await fixture(t);
  for (const [raw, shape, sql, expected] of [
    ["root:\n  count: 7\n", "yaml", "SELECT root.count AS n FROM evidence", 7],
    ['<?xml version="1.0"?><root><count>8</count></root>', "xml", "SELECT root.count AS n FROM evidence", 8],
    ["n,name\n9,Ada\n", "csv", "SELECT n FROM evidence", 9],
    ["n\tname\n10\tAda\n", "tsv", "SELECT n FROM evidence", 10],
  ] as const) {
    const evidence = await store.captureRaw("sql-test", {}, raw, "tool_result", shape);
    assert.deepEqual((await store.querySql(evidence.evidenceId, sql)).rows, [{ n: expected }]);
  }
});

test("row-limited and byte-limited derived evidence explicitly identify retained previews", async t => {
  const { store, evidence } = await fixture(t);
  for (const sql of ["SELECT i FROM evidence, range(1000000000) t(i)", "SELECT repeat('x', 100000) AS value FROM evidence"]) {
    const result = await store.querySql(evidence.evidenceId, sql);
    assert.equal(result.truncated, true);
    assert.ok(result.outputEvidence);
    const { metadata } = await store.getEvidence(result.outputEvidence.evidenceId);
    const retained = JSON.parse(await readFile(metadata.rawPath, "utf8"));
    assert.equal(retained.truncated, true);
    assert.match(retained.scope, /not the complete/);
    assert.ok(retained.rows.length <= 201);
    assert.ok(Buffer.byteLength(JSON.stringify(result.rows)) <= 65536 + 1024);
  }
});

test("oversized scalar and nested results fail before binding conversion; later queries work", async t => {
  const { store, evidence } = await fixture(t);
  for (const value of ["repeat('x', 2000000)", "{'nested': [repeat('x', 2000000)]}"]) {
    await assert.rejects(store.querySql(evidence.evidenceId, `SELECT ${value} AS value FROM evidence`), new RegExp(`${SQL_MATERIALIZATION_BYTES} byte materialization limit`));
  }
  assert.deepEqual((await store.querySql(evidence.evidenceId, "SELECT 42 AS n FROM evidence")).rows, [{ n: 42 }]);
  await assertNoWorkers();
});

test("effective DuckDB memory budget and spill prohibition fail explicitly under pressure", async t => {
  const { store, evidence } = await fixture(t);
  const settings = await store.querySql(evidence.evidenceId, "SELECT current_setting('memory_limit') AS memory, current_setting('temp_directory') AS spill, current_setting('enable_external_access') AS external FROM evidence");
  assert.deepEqual(settings.rows, [{ memory: "244.1 MiB", spill: "", external: false }]);
  await assert.rejects(store.querySql(evidence.evidenceId, "SELECT repeat('x', 300000000) AS value FROM evidence"), /Out of Memory|could not allocate/i);
  assert.deepEqual((await store.querySql(evidence.evidenceId, "SELECT 1 AS n FROM evidence")).rows, [{ n: 1 }]);
  await assertNoWorkers();
});

test("expensive SQL is killed and reaped within the wall-time envelope", async t => {
  const { store, evidence } = await fixture(t);
  const start = Date.now();
  await assert.rejects(store.querySql(evidence.evidenceId, "SELECT sum(sin(a.i + b.i)) FROM evidence, range(100000) a(i), range(100000) b(i)"), /analysis timeout/);
  assert.ok(Date.now() - start < SQL_TIMEOUT_MS + 1500);
  await assertNoWorkers();
  assert.deepEqual((await store.querySql(evidence.evidenceId, "SELECT 1 AS n FROM evidence")).rows, [{ n: 1 }]);
});

test("schema ingestion has the same killable deadline, including a blocked source read", { skip: process.platform === "win32" }, async t => {
  const { directory, evidence } = await fixture(t);
  const path = join(directory, "blocked.json");
  await exec("mkfifo", [path]);
  const start = Date.now();
  await assert.rejects(analyzeSql({ ...evidence, rawPath: path }), /analysis timeout/);
  assert.ok(Date.now() - start < SQL_TIMEOUT_MS + 1500);
  await assertNoWorkers();
});

test("external-read and write validation remains closed", async t => {
  const { store, evidence } = await fixture(t);
  for (const sql of ["SELECT * FROM evidence, read_text('/etc/passwd')", "SELECT * FROM evidence; DROP TABLE evidence", "WITH x AS (SELECT * FROM read_csv_auto('/etc/passwd')) SELECT * FROM evidence, x"]) {
    await assert.rejects(store.querySql(evidence.evidenceId, sql), /prohibited|semicolons/);
  }
});
