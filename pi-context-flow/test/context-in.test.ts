import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stressFixture = (name: string) => readFile(join(process.cwd(), "fixtures", "record-query-stress", name), "utf8");
import test from "node:test";
import { assertCaptureWorkspacePathAllowed, assertReplWorkspacePathAllowed, ContextStore } from "../src/store.js";
import { serializeToolContent, shouldAutoCapture } from "../src/index.js";

async function makeStore(): Promise<ContextStore> {
  const store = new ContextStore(await mkdtemp(join(tmpdir(), "pi-context-flow-")));
  await store.initialize();
  return store;
}

test("captures raw interception text losslessly with JSON, text, and mixed classifications", async () => {
  const store = await makeStore();
  const json = await store.captureRaw("tool", {}, '{"items":[{"id":1}]}');
  const text = await store.captureRaw("tool", {}, "first plain line\nsecond plain line\n");
  const mixed = await store.captureRaw("tool", {}, "2026-01-01 INFO started\n{\"event\":\"ready\"}\n");
  assert.equal(json.shape, "json"); assert.equal(text.shape, "text"); assert.equal(mixed.shape, "mixed");
  assert.equal(await readFile(text.rawPath, "utf8"), "first plain line\nsecond plain line\n");
  const mixedSql = await store.querySql(mixed.evidenceId, "SELECT line, json, byte_start, byte_end, line_start, line_end FROM evidence");
  assert.deepEqual(mixedSql.rows, [{ line: 2, json: '{"event":"ready"}', byte_start: Buffer.byteLength("2026-01-01 INFO started\n"), byte_end: Buffer.byteLength("2026-01-01 INFO started\n{\"event\":\"ready\"}\n"), line_start: 2, line_end: 2 }]);
  const reference = await store.reference(text.evidenceId);
  assert.deepEqual(reference.tools, ["context_search", "context_read"]);
  assert.equal(reference.sizeBytes, Buffer.byteLength("first plain line\nsecond plain line\n"));
  assert.match(json.sha256, /^[a-f0-9]{64}$/);
  const relation = await store.inspectSchema(`evidence://${json.evidenceId}`) as { relation: string; columns: Array<{ name: string; type: string }>; rowCount: number };
  assert.equal(relation.relation, "evidence");
  assert.deepEqual(relation.columns.map((column) => column.name), ["items"]);
  assert.equal(relation.columns[0].type, "STRUCT(...)[]");
  const fullRelation = await store.inspectSchema(json.evidenceId, { detail: "full" }) as { columns: Array<{ type: string }> };
  assert.match(fullRelation.columns[0].type, /STRUCT\(id BIGINT\)\[\]/);
  assert.equal(relation.rowCount, 1);
});

test("chunks text with source offsets and supports bounded lexical reads and search", async () => {
  const store = await makeStore();
  const raw = `alpha startup\nbravo needle target\ncharlie done\n${"z".repeat(20000)}\n`;
  const evidence = await store.captureRaw("log", {}, raw);
  const hits = await store.searchText(evidence.evidenceId, "needle");
  assert.equal(hits.hits.length, 1); assert.equal(hits.hits[0].line_start, 1);
  const range = await store.readText(evidence.evidenceId, { lineStart: 2, lineEnd: 2 });
  assert.equal(range.text, "bravo needle target\n"); assert.equal(range.byteStart, Buffer.byteLength("alpha startup\n"));
  const capped = await store.readText(evidence.evidenceId, { byteStart: 0, byteEnd: Buffer.byteLength(raw) });
  assert.equal(capped.truncated, true); assert.ok(Buffer.byteLength(capped.text) <= 16 * 1024);
  await assert.rejects(store.searchText(evidence.evidenceId, "needle", "hybrid"), /unavailable/);
});

test("supports bounded JSON paths and rejects full raw evidence escape", async () => {
  const store = await makeStore();
  const evidence = await store.captureRaw("json", {}, JSON.stringify({ huge: "x".repeat(20000), items: [{ id: 1 }] }));
  const path = await store.readJson(evidence.evidenceId, "$.items[0].id");
  assert.equal(path.value, 1); assert.equal(path.truncated, false);
  const huge = await store.readJson(evidence.evidenceId, "$.huge");
  assert.equal(huge.truncated, true);
  await assert.rejects(store.getEvidence(evidence.evidenceId, 16385), /maxBytes/);
  const preview = await store.getEvidence(evidence.evidenceId);
  assert.equal(preview.truncated, true);
});

test("SQL permits one bounded evidence query and fails closed against injection and external reads", async () => {
  const store = await makeStore();
  const evidence = await store.capture("json", {}, [{ id: 1, state: "open" }, { id: 2, state: "closed" }]);
  const good = await store.querySql(evidence.evidenceId, "SELECT id FROM evidence WHERE state = 'open';");
  assert.deepEqual(good.rows, [{ id: 1 }]);
  const compact = await store.querySql(evidence.evidenceId, "SELECT json_object('id', id) AS result FROM evidence WHERE state = 'open'", "json");
  assert.deepEqual(compact.result, '{"id":1}');
  const literal = await store.querySql(evidence.evidenceId, "SELECT 'evidence' AS label FROM evidence LIMIT 1 -- evidence in a comment");
  assert.deepEqual(literal.rows, [{ label: "evidence" }]);
  for (const sql of ["SELECT * FROM evidence; DELETE FROM evidence", "COPY evidence TO '/tmp/leak'", "SELECT * FROM read_csv_auto('/etc/passwd')", "PRAGMA version", "SELECT * FROM evidence JOIN read_json_auto('/tmp/x') x ON true", "SELECT * FROM observations", "SELECT * FROM evidence_queries", "SELECT * FROM pg_tables", "SELECT * FROM pragma_table_info('evidence')"]) await assert.rejects(store.querySql(evidence.evidenceId, sql), /SQL|Catalog/);
});

test("queries nested Linear-like records without a prior schema call", async () => {
  const store = await makeStore();
  const evidence = await store.capture("linear", {}, {
    result: {
      issues: [
        { identifier: "ENG-1", title: "Old", state: { name: "Todo" }, priority: 1 },
        { identifier: "ENG-2", title: "Urgent", state: { name: "Todo" }, priority: 3 },
        { identifier: "ENG-3", title: "Done", state: { name: "Done" }, priority: 2 },
      ],
    },
  });
  const result = await store.queryRecords(evidence.evidenceId, {
    collectionHint: "issues",
    filters: [{ field: "state.name", oneOf: ["Todo"] }],
    select: ["identifier", "title", "priority"],
    orderBy: [{ field: "priority", direction: "desc" }],
    limit: 2,
  });
  assert.deepEqual(result.records, [
    { identifier: "ENG-2", title: "Urgent", priority: 3 },
    { identifier: "ENG-1", title: "Old", priority: 1 },
  ]);
  assert.match(result.query.query, /CROSS JOIN UNNEST\("result"\."issues"\)/);
});

test("JSON-RPC capture extracts primary result evidence and retains the raw transport", async () => {
  const store = await makeStore();
  const raw = JSON.stringify({ jsonrpc: "2.0", id: "request-1", result: { issues: [{ id: "PAY-1", title: "Oldest", createdAt: "2024-01-01" }] } });
  const captured = await store.captureIntercepted("mcp", {}, raw);
  assert.equal(captured.jsonRpc?.role, "result");
  assert.ok(captured.jsonRpc?.transportEvidenceId);
  assert.deepEqual(captured.evidence.dependencies, [captured.jsonRpc?.transportEvidenceId]);
  const schema = await store.describeRelation(captured.evidence.evidenceId, "full");
  assert.deepEqual(schema.columns.map((column) => column.name), ["issues"]);
  const records = await store.queryRecords(captured.evidence.evidenceId, { collectionHint: "issues", select: ["id", "title"], limit: 1 });
  assert.deepEqual(records.records, [{ id: "PAY-1", title: "Oldest" }]);
  const transport = await store.describeRelation(captured.jsonRpc!.transportEvidenceId, "full");
  assert.deepEqual(transport.columns.map((column) => column.name), ["jsonrpc", "id", "result"]);
  const metadata = await store.evidenceMetadata(captured.evidence.evidenceId);
  assert.equal(metadata.type, "json");
  assert.equal(metadata.jsonRpc?.role, "result");
  assert.equal(metadata.jsonRpc?.transportEvidence, `evidence://${captured.jsonRpc!.transportEvidenceId}`);
});

test("record queries fail closed for ambiguous collections and invalid scalar paths", async () => {
  const store = await makeStore();
  const evidence = await store.capture("records", {}, {
    issues: [{ id: "root", state: { name: "Todo" }, labels: [{ name: "bug" }] }],
    result: { issues: [{ id: "nested", state: { name: "Done" } }] },
  });
  await assert.rejects(store.queryRecords(evidence.evidenceId, { collectionHint: "issues", limit: 1 }), /ambiguous.*issues, result\.issues/i);
  await assert.rejects(store.queryRecords(evidence.evidenceId, { collectionHint: "missing", limit: 1 }), /Candidates: issues, result\.issues/);
  const unambiguous = await store.capture("records", {}, { result: { issues: [{ id: "only", state: { name: "Todo" }, labels: [{ name: "bug" }] }] } });
  await assert.rejects(store.queryRecords(unambiguous.evidenceId, { collectionHint: "issues", filters: [{ field: "labels", equals: "bug" }], limit: 1 }), /not a scalar path/);
  await assert.rejects(store.queryRecords(unambiguous.evidenceId, { collectionHint: "issues", select: ["state"], limit: 1 }), /not a scalar path/);
  await assert.rejects(store.queryRecords(unambiguous.evidenceId, { collectionHint: "my issues", limit: 1 }), /natural-language matching is unavailable/);
  await assert.rejects(store.queryRecords(unambiguous.evidenceId, { collectionHint: "issues", filters: [{ field: "id", equals: 1 }], limit: 1 }), /does not match authoritative type/);
});

test("handles realistic GitHub, Slack, and Kubernetes root record collections", async () => {
  const store = await makeStore();
  const github = await store.captureRaw("github", {}, await stressFixture("github-pulls.json"));
  const pulls = await store.queryRecords(github.evidenceId, {
    collectionHint: "pulls",
    filters: [{ field: "state", equals: "open" }],
    select: ["number", "title", "user.login", "milestone.title"],
    orderBy: [{ field: "number", direction: "desc" }],
    limit: 10,
  });
  assert.deepEqual(pulls.records, [{ number: 104, title: "Fix retry backoff", "user.login": "ada", "milestone.title": null }]);

  const slack = await store.captureRaw("slack", {}, await stressFixture("slack-history.json"));
  const messages = await store.queryRecords(slack.evidenceId, {
    collectionHint: "messages",
    filters: [{ field: "type", equals: "message" }],
    select: ["user", "text", "thread_ts"],
    orderBy: [{ field: "ts", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(messages.records, [
    { user: "U-ADA", text: "Investigating the payment timeout", thread_ts: null },
    { user: "B-DEPLOY", text: "Deploy finished", thread_ts: "1773133200.000100" },
    { user: "U-LIN", text: "Standup notes 1", thread_ts: null },
    { user: "U-BEA", text: "On-call handoff summary 2", thread_ts: null },
    { user: "U-LIN", text: "Invoice sync report 3", thread_ts: null },
    { user: "U-BEA", text: "Capacity planning update 4", thread_ts: null },
    { user: "U-LIN", text: "Release checklist item 5", thread_ts: null },
    { user: "U-BEA", text: "Standup notes 6", thread_ts: null },
    { user: "U-LIN", text: "On-call handoff summary 7", thread_ts: null },
    { user: "U-BEA", text: "Invoice sync report 8", thread_ts: null },
  ]);
  // All fixture rows are messages already in timestamp order; also guard against omitted clauses.
  assert.match(messages.query.query, /WHERE item\."type" = 'message' ORDER BY item\."ts" ASC LIMIT 10\b/);

  const kubernetes = await store.captureRaw("kubernetes", {}, await stressFixture("kubernetes-pods.json"));
  const pods = await store.queryRecords(kubernetes.evidenceId, {
    collectionHint: "items",
    filters: [{ field: "status.phase", equals: "Running" }],
    select: ["metadata.name", "metadata.namespace", "status.phase"],
    orderBy: [{ field: "metadata.name", direction: "asc" }],
    limit: 10,
  });
  // SQL without ORDER BY has no stable first page; request an explicit order.
  assert.deepEqual(pods.records, [
    "api-0000", "api-0cd4", "api-1005", "api-1336", "api-1667",
    "api-233b", "api-266c", "api-299d", "api-2cce", "api-3cd3",
  ].map((name) => ({ "metadata.name": name, "metadata.namespace": "payments", "status.phase": "Running" })));
});

test("fails closed for nested collections, maps, and non-identifier API keys", async () => {
  const store = await makeStore();
  const github = await store.captureRaw("github", {}, await stressFixture("github-pulls.json"));
  await assert.rejects(store.queryRecords(github.evidenceId, { collectionHint: "labels", limit: 1 }), /No LIST-of-STRUCT collection matches.*Candidates: pulls/);

  const slack = await store.captureRaw("slack", {}, await stressFixture("slack-history.json"));
  await assert.rejects(store.queryRecords(slack.evidenceId, { collectionHint: "messages", select: ["reactions"], limit: 1 }), /not a scalar path/);

  const kubernetes = await store.captureRaw("kubernetes", {}, await stressFixture("kubernetes-pods.json"));
  await assert.rejects(store.queryRecords(kubernetes.evidenceId, { collectionHint: "items", filters: [{ field: "metadata.labels.app.kubernetes.io/name", equals: "api" }], limit: 1 }), /dot-separated identifiers/);

  const aws = await store.captureRaw("aws", {}, await stressFixture("aws-ec2.json"));
  const reservations = await store.queryRecords(aws.evidenceId, {
    collectionHint: "Reservations",
    select: ["ReservationId"],
    orderBy: [{ field: "ReservationId", direction: "asc" }],
    limit: 10,
  });
  assert.deepEqual(reservations.records, [{ ReservationId: "r-001" }, { ReservationId: "r-002" }]);
  await assert.rejects(store.queryRecords(aws.evidenceId, { collectionHint: "Instances", limit: 1 }), /No LIST-of-STRUCT collection matches.*Candidates: Reservations/);
});

test("captures workspace JSON, CSV, TSV, XML, YAML, and logs without native read", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-flow-capture-file-"));
  const store = new ContextStore(cwd); await store.initialize();
  const files: Array<[string, string, string, string]> = [
    ["records.json", '[{"id":1,"state":"open"}]', "auto", "json"],
    ["records.csv", "id,state\n1,open\n", "data", "csv"],
    ["records.tsv", "id\tstate\n1\topen\n", "data", "tsv"],
    ["records.xml", "<?xml version=\"1.0\"?><records><record id=\"1\"><state>open</state></record></records>", "data", "xml"],
    ["records.yaml", "records:\n  - id: 1\n    state: open\n", "data", "yaml"],
    ["service.log", "2026-03-01T00:00:00Z ERROR api request_id=req-1 failed\n", "log", "mixed"],
  ];
  for (const [path, raw, kind, shape] of files) {
    await writeFile(join(cwd, path), raw);
    const evidence = await store.captureFile(path, kind as "auto" | "data" | "log");
    assert.equal(evidence.shape, shape, path);
  }
  const csv = await store.captureFile("records.csv", "data");
  const rows = await store.querySql(csv.evidenceId, "SELECT id, state FROM evidence");
  assert.deepEqual(rows.rows, [{ id: 1, state: "open" }]);
});

test("capture file fails closed for source, binary, escaped, and protected paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-flow-capture-policy-"));
  const store = new ContextStore(cwd); await store.initialize();
  await writeFile(join(cwd, "source.ts"), "export const value = 1;\\n");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0xff, 0xfe]));
  await mkdir(join(cwd, ".pi", "context"), { recursive: true }); await writeFile(join(cwd, ".pi", "context", "hidden.json"), "{}");
  await assert.rejects(store.captureFile("source.ts"), /Unsupported text artifact/);
  await assert.rejects(store.captureFile("binary.dat"), /Binary files/);
  await assert.rejects(store.captureFile(".pi/context/hidden.json"), /cannot be captured/);
  assert.throws(() => assertCaptureWorkspacePathAllowed(cwd, join(cwd, ".pi", "context", "state.duckdb")), /cannot be captured/);
});

test("auto-capture classification covers data and logs but not source prose", async () => {
  const samples: Array<[string, string]> = [
    ['{"items":[1]}', "json"],
    ["id,state\n1,open\n", "csv"],
    ["id\tstate\n1\topen\n", "tsv"],
    ["<?xml version=\"1.0\"?><item/>", "xml"],
    ["title: Runbook\nowner: platform\n", "yaml"],
    ["2026-03-01 ERROR service failed", "mixed"],
  ];
  const store = await makeStore();
  for (const [raw, shape] of samples) {
    assert.equal(shouldAutoCapture(raw), true, shape);
    const evidence = await store.captureRaw("mcp", {}, raw);
    const reference = await store.reference(evidence.evidenceId);
    assert.equal(reference.shape, shape);
    assert.match(reference.tools.join(","), /context_schema|context_search/);
  }
  assert.equal(shouldAutoCapture("export function useful() { return 1; }"), false);
  assert.equal(shouldAutoCapture("A normal prose document has no data format."), false);
});

test("captures oversized SQL output as derived evidence and records provenance", async () => {
  const store = await makeStore();
  const evidence = await store.capture("json", {}, Array.from({ length: 200 }, (_, id) => ({ id, value: "x".repeat(1000) })));
  const result = await store.querySql(evidence.evidenceId, "SELECT * FROM evidence");
  assert.equal(result.truncated, true); assert.ok(result.outputEvidence); assert.equal(result.outputEvidence?.source, "sql output");
});

test("REPL workspace staging blocks Context In storage without requiring a container runtime", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-flow-repl-policy-"));
  const protectedPath = join(cwd, ".pi", "context", "evidence", "raw", "evidence.txt");
  assert.throws(() => assertReplWorkspacePathAllowed(cwd, protectedPath), /\.pi\/context cannot be staged/);
  assert.doesNotThrow(() => assertReplWorkspacePathAllowed(cwd, join(cwd, "src", "safe.ts")));
});

test("REPL reports container availability without a host execution fallback", async () => {
  const store = await makeStore();
  const result = await store.repl({ language: "bash", code: "echo container-only" });
  if (!result.available) assert.match(result.reason ?? "", /host execution is never used/);
  else assert.ok(result.invocationId, "a reported execution is a container invocation");
});

test("jq uses an allowlisted environment and stages complete oversized output", { skip: !process.env.PATH?.split(":").some((directory) => existsSync(join(directory, "jq"))) }, async () => {
  const store = await makeStore();
  const secret = "context-flow-secret-must-not-leak";
  process.env.CONTEXT_FLOW_SENTINEL = secret;
  try {
    const evidence = await store.capture("json", {}, { values: Array.from({ length: 700 }, (_, index) => ({ index, value: "x".repeat(100) })) });
    const result = await store.queryJq(evidence.evidenceId, ".values");
    assert.equal(result.truncated, true);
    assert.ok(result.outputEvidence, "oversized jq output is retained as evidence");
    assert.deepEqual(result.result && typeof result.result === "object" ? (result.result as { complete?: boolean }).complete : undefined, false);
    const secretResult = await store.queryJq(evidence.evidenceId, "env.CONTEXT_FLOW_SENTINEL");
    assert.equal(secretResult.result, null);
    const retained = await store.getEvidence(result.outputEvidence!.evidenceId, 16_384);
    assert.equal(retained.truncated, true, "the retained complete artifact is larger than the preview budget");
  } finally { delete process.env.CONTEXT_FLOW_SENTINEL; }
});

test("REPL stages oversized container output when a usable container runtime is present", async (t) => {
  const store = await makeStore();
  const result = await store.repl({ language: "bash", code: "yes x | head -c 70000" });
  if (!result.available) { t.skip("Docker/Podman server or cached bash image is unavailable"); return; }
  assert.equal(result.exitCode, 0);
  assert.ok(result.outputEvidence, "oversized REPL output is retained as evidence");
  assert.match(result.output ?? "", /output truncated/);
});


test("auto-capture replaces large tool output with a compact JSON reference", async () => {
  const extension = (await import("../src/index.js")).default;
  let handler: ((event: { toolName: string; input: unknown; content: unknown }, ctx: { cwd: string }) => Promise<unknown>) | undefined;
  extension({ on(name: string, callback: typeof handler) { if (name === "tool_result") handler = callback; }, registerTool() {} } as never);
  const directory = await mkdtemp(join(tmpdir(), "pi-context-flow-intercept-"));
  try {
    const result = await handler!({ toolName: "mcp_call", input: {}, content: [{ type: "text", text: JSON.stringify({ jsonrpc: "2.0", id: "request-1", result: { issues: Array.from({ length: 1000 }, (_, index) => ({ id: index })) } }) }] }, { cwd: directory }) as { content: Array<{ text: string }> };
    const reference = JSON.parse(result.content[0].text);
    assert.match(reference.evidence, /^evidence:\/\/evidence_/);
    assert.deepEqual(Object.keys(reference).sort(), ["evidence", "type"]);
    assert.equal(reference.type, "json");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("interception capture envelope preserves chunk boundaries without synthetic separators", () => {
  const captured = serializeToolContent([{ type: "text", text: "left" }, { type: "text", text: "right" }, { type: "image", data: "safe" }]);
  assert.equal(captured, '{"version":1,"content":[{"type":"text","text":"left"},{"type":"text","text":"right"},{"type":"image","data":"safe"}]}\n');
  const circular: { self?: unknown } = {}; circular.self = circular;
  assert.equal(serializeToolContent(circular), undefined, "unsupported payloads bypass interception rather than being altered");
});
