import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextStore } from "../src/store.js";

type Row = Record<string, unknown>;
type SearchInternals = { all(sql: string, values?: unknown[]): Promise<Row[]> };

async function makeStore(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "context-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ContextStore(directory);
  await store.initialize();
  return store;
}

test("large lexical scans find late matches, normalize IDs and preserve byte/line ranges", async (t) => {
  const store = await makeStore(t);
  const raw = "common ordinary log entry café\n".repeat(12000) + "common uniquelate signal\n";
  const evidence = await store.captureRaw("log", {}, raw);
  const bytes = Buffer.from(raw);
  assert.ok(bytes.length > 5 * 64 * 1024);
  const rawResult = await store.searchText(evidence.evidenceId, "uniquelate");
  const uriResult = await store.searchText(`evidence://${evidence.evidenceId}`, "uniquelate");
  assert.deepEqual(uriResult, rawResult);
  assert.equal(rawResult.complete, true);
  assert.equal(rawResult.truncated, false);
  assert.equal(rawResult.scannedBytes, bytes.length);
  assert.ok(rawResult.scannedChunks > 16);
  assert.equal(rawResult.hits.length, 1);
  const hit = rawResult.hits[0];
  assert.ok(Number(hit.byte_start) > 64 * 1024);
  assert.equal(hit.text, bytes.subarray(Number(hit.byte_start), Number(hit.byte_end)).toString("utf8"));
  const range = await store.readText(`evidence://${evidence.evidenceId}`, { byteStart: Number(hit.byte_start), byteEnd: Number(hit.byte_end) });
  assert.equal(range.text, hit.text);
  assert.equal(range.lineStart, hit.line_start);
  assert.equal(range.lineEnd, hit.line_end);
  const lines = await store.readText(evidence.evidenceId, { lineStart: Number(hit.line_start), lineEnd: Number(hit.line_end) });
  assert.equal(lines.text, hit.text);

  const common = await store.searchText(evidence.evidenceId, "common", "lexical", 50);
  assert.equal(common.complete, true);
  assert.equal(common.truncated, true);
  assert.ok(common.hits.length > 0 && common.hits.length <= 50);
  assert.ok(Buffer.byteLength(JSON.stringify(common)) <= 64 * 1024);
  assert.deepEqual(common.hits.map((row) => Number(row.chunk_index)), common.hits.map((_, i) => i));
  assert.deepEqual(await store.searchText(evidence.evidenceId, "common", "lexical", 50), common);
  const ranked = await store.searchText(evidence.evidenceId, "common uniquelate common", "lexical", 2);
  assert.equal(ranked.hits[0].score, 2);
  assert.equal(ranked.hits[0].chunk_index, hit.chunk_index);
  assert.equal(ranked.hits[1].chunk_index, 0);
  const absent = await store.searchText(`evidence://${evidence.evidenceId}`, "absentword");
  assert.deepEqual(absent.hits, []);
  assert.equal(absent.complete, true);
  assert.equal(absent.truncated, false);
  assert.equal(absent.scannedBytes, bytes.length);
});

test("invalid lexical requests fail explicitly", async (t) => {
  const store = await makeStore(t);
  const evidence = await store.captureRaw("log", {}, "small needle log\n");
  for (const query of ["", "  ", "!!! ---", "a"]) await assert.rejects(store.searchText(evidence.evidenceId, query), /required|no lexical terms/);
  for (const limit of [0, -1, 51, 1.5, NaN, Infinity]) await assert.rejects(store.searchText(evidence.evidenceId, "needle", "lexical", limit), /limit/);
  await assert.rejects(store.searchText(evidence.evidenceId, "x".repeat(1025)), /1024 bytes/);
  await assert.rejects(store.searchText(evidence.evidenceId, Array.from({ length: 33 }, (_, i) => `term${i}`).join(" ")), /32 lexical terms/);
  await assert.rejects(store.searchText(evidence.evidenceId, "needle", "hybrid"), /unavailable/);
  await assert.rejects(store.searchText(evidence.evidenceId, "needle", "invalid" as "lexical"), /Unknown search mode/);
  await assert.rejects(store.searchText("evidence://missing", "needle"), /not found|Unknown/i);
  const result = await store.searchText(evidence.evidenceId, "NEEDLE needle");
  assert.equal(result.hits[0].score, 1);
});

test("paging and top-k remain bounded on common terms and report scan exhaustion", async (t) => {
  const store = await makeStore(t);
  const evidence = await store.captureRaw("log", {}, "needle\n");
  const internals = store as unknown as SearchInternals;
  const original = internals.all.bind(store);
  let pages = 0;
  let chunkBytes = 4096;
  // A synthetic index exercises the scan ceiling without thousands of capture
  // inserts. Metadata and all integration/range coverage use the real database.
  internals.all = async (sql, values) => {
    if (!sql.includes("FROM text_chunks")) return original(sql, values);
    assert.match(sql, /chunk_index > \? ORDER BY chunk_index LIMIT \?/);
    assert.equal(values?.[0], evidence.evidenceId);
    assert.equal(values?.[2], 64);
    pages++;
    return Array.from({ length: 64 }, (_, i) => {
      const index = Number(values?.[1]) + 1 + i;
      return { chunk_index: index, byte_start: index * chunkBytes, byte_end: (index + 1) * chunkBytes, line_start: index + 1, line_end: index + 1, text: `needle ${"x".repeat(chunkBytes - 8)}\n` };
    });
  };
  const result = await store.searchText(`evidence://${evidence.evidenceId}`, "needle", "lexical", 50);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.match(result.incompleteReason!, /budget exhausted/);
  assert.equal(result.scannedChunks, 4096);
  assert.equal(result.scannedBytes, 16 * 1024 * 1024);
  assert.equal(pages, 65); // One bounded lookahead page distinguishes exact EOF.
  assert.ok(result.hits.length <= 50);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  assert.deepEqual(result.hits.map((hit) => hit.chunk_index), result.hits.map((_, i) => i));

  // The capture chunker can include a newline at offset +4096 (4097 bytes).
  // Exercise the independent byte ceiling and an incomplete no-match result.
  chunkBytes = 4097;
  const absent = await store.searchText(evidence.evidenceId, "absentword");
  assert.equal(absent.complete, false);
  assert.equal(absent.truncated, true);
  assert.deepEqual(absent.hits, []);
  assert.equal(absent.scannedChunks, 4095);
  assert.equal(absent.scannedBytes, 4095 * 4097);
});

test("response byte limit includes JSON escaping", async (t) => {
  const store = await makeStore(t);
  const raw = (`needle ${"\u0001".repeat(4000)}\n`).repeat(30);
  const evidence = await store.captureRaw("log", {}, raw);
  const result = await store.searchText(evidence.evidenceId, "needle", "lexical", 50);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, true);
  assert.ok(result.hits.length > 0 && result.hits.length < 30);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
});

test("elapsed budget includes database waits and schedules no pages after timeout", async (t) => {
  const store = await makeStore(t);
  const evidence = await store.captureRaw("log", {}, "needle\n");
  const internals = store as unknown as SearchInternals;
  const original = internals.all.bind(store);
  let pages = 0;
  let finishPage!: (rows: Row[]) => void;
  internals.all = async (sql, values) => {
    if (!sql.includes("FROM text_chunks")) return original(sql, values);
    pages++;
    return new Promise<Row[]>((resolve) => { finishPage = resolve; });
  };
  const start = performance.now();
  await assert.rejects(store.searchText(evidence.evidenceId, "needle"), /2000ms execution budget/);
  assert.ok(performance.now() - start < 3000);
  finishPage([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pages, 1);
  internals.all = original;
  assert.equal((await store.searchText(evidence.evidenceId, "needle")).hits.length, 1);
});
