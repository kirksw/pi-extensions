import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { ContextStore } from "../src/store.js";

type ToolResultEventResult = Partial<Pick<ToolResultEvent, "content" | "details" | "isError">>;
type Handler = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<ToolResultEventResult | void>;
const text = (value: string) => ({ type: "text", text: value });
const data = JSON.stringify({ records: Array.from({ length: 500 }, (_, id) => ({ id, label: "雪 data" })) });
const log = "2026-03-01 INFO service ready 雪\r\n".repeat(350);

async function harness(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-interception-boundary-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let handler: Handler | undefined;
  extension({
    on(name: string, callback: unknown) { if (name === "tool_result") handler = callback as Handler; },
    registerTool() {},
  } as unknown as ExtensionAPI);
  assert.ok(handler, "extension registers the actual tool-result hook");
  return {
    cwd,
    async invoke(content: unknown, toolName = "mcp_call", isError = false, details: unknown = { original: true }) {
      const event = { type: "tool_result", toolCallId: "call-1", toolName, input: { request: "original" }, content, details, isError } as ToolResultEvent;
      const result = await handler!(event, { cwd } as ExtensionContext);
      assert.equal(event.content, content, "hook never mutates original content");
      assert.equal(event.details, details);
      return result;
    },
    async rawFiles() {
      const directory = join(cwd, ".pi", "context", "evidence", "raw");
      return Promise.all((await readdir(directory)).map(async (name) => ({ name, raw: await readFile(join(directory, name), "utf8") })));
    },
  };
}

function reference(result: ToolResultEventResult | void) {
  assert.ok(result?.content);
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.equal(block.type, "text");
  if (block.type !== "text") throw new Error("Expected text reference");
  const value = JSON.parse(block.text) as { evidence: string; type: string };
  assert.deepEqual(Object.keys(value).sort(), ["evidence", "type"]);
  assert.match(value.evidence, /^evidence:\/\/evidence_/);
  return value;
}

test("hook bypasses multi-item prose/source and mixed supported/unsupported content unchanged", async (t) => {
  const h = await harness(t);
  const prose = "A normal prose document explains the application in detail.\n".repeat(200);
  const source = "export function useful() { return 1; }\n".repeat(300);
  for (const content of [
    [text(prose), text(prose)],
    [text(source), text(source)],
    [text(data), text(prose)],
    [text(source), text(log)],
    [text(data), { type: "image", data: "base64", mimeType: "image/png" }],
    [{ type: "image", data: "base64", mimeType: "image/png" }, text(log)],
    [text(data), { type: "resource", uri: "resource://original" }],
    [text(data), null],
    [text(data), { type: "text", text: 123 }],
    { content: [text(data)] },
    [],
  ]) assert.equal(await h.invoke(content), undefined);
  assert.deepEqual(await readdir(h.cwd), [], "bypasses do not initialize evidence storage");
});

test("hook bypasses cyclic, lossy, and custom-serialized content without invoking getters", async (t) => {
  const h = await harness(t);
  const cyclic: Record<string, unknown> = text(data);
  cyclic.self = cyclic;
  const cyclicArray: unknown[] = [text(data)];
  cyclicArray.push(cyclicArray);
  const getter = { type: "text", get text(): string { throw new Error("must not evaluate text getter"); } };
  const sparse = [text(data), , text(log)];
  for (const content of [
    [cyclic], [text(data), cyclic], cyclicArray, sparse,
    [text(data), getter],
    [{ ...text(data), extra: 1n }],
    [{ ...text(data), extra: undefined }],
    [{ ...text(data), [Symbol("extra")]: "lost" }],
    [{ ...text(data), toJSON() { throw new Error("must not invoke toJSON"); } }],
    [{ ...text(data), textSignature: undefined }],
  ]) assert.equal(await h.invoke(content), undefined);
  assert.deepEqual(await readdir(h.cwd), []);
});

test("hook preserves exclusions and applies threshold to original UTF-8 text bytes", async (t) => {
  const h = await harness(t);
  for (const tool of ["read", "grep", "find", "ls", "context_capture", "context_read", "context_future_tool"]) {
    assert.equal(await h.invoke([text(data), text(log)], tool), undefined);
  }
  const exact = JSON.stringify("x".repeat(8190));
  assert.equal(Buffer.byteLength(exact), 8192);
  for (const content of [[text(exact)], [text(JSON.stringify("x".repeat(4094))), text(JSON.stringify("y".repeat(4094)))]]) {
    assert.equal(await h.invoke(content), undefined, "serialized envelope overhead does not count toward threshold");
  }
  assert.deepEqual(await readdir(h.cwd), []);
  const unicode = JSON.stringify("雪".repeat(3000));
  reference(await h.invoke([text(unicode)]));
  assert.equal((await h.rawFiles())[0].raw, unicode);
});

test("hook captures single JSON and logs losslessly with compact references", async (t) => {
  const h = await harness(t);
  for (const raw of [data, log]) {
    const ref = reference(await h.invoke([text(raw)]));
    const files = await h.rawFiles();
    assert.equal(files.find((file) => file.name.startsWith(ref.evidence.slice("evidence://".length)))?.raw, raw);
  }
});

test("hook captures qualifying multiple text items with exact order and chunk boundaries", async (t) => {
  const h = await harness(t);
  for (const content of [
    [text(data), text("  " + data + "\n")],
    [text(log), { ...text(log.replaceAll("ready", "finished")), textSignature: "signature" }],
    [text(data), text(log)],
    Array.from({ length: 1000 }, (_, id) => text(JSON.stringify({ id }))),
  ]) {
    const ref = reference(await h.invoke(content));
    const raw = (await h.rawFiles()).find((file) => file.name.startsWith(ref.evidence.slice("evidence://".length)))?.raw;
    assert.equal(raw, JSON.stringify({ version: 1, content }) + "\n");
    assert.deepEqual(JSON.parse(raw!).content, content);
  }
});

test("hook retains single-text JSON-RPC result/error extraction and exact transport", async (t) => {
  const h = await harness(t);
  for (const payload of [{ result: { records: data } }, { error: { code: -32000, message: log } }]) {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: "request-1", ...payload }, null, 2) + "\n";
    const result = await h.invoke([text(raw)]);
    const ref = reference(result);
    const details = result!.details as { contextFlow: { jsonRpc: { role: string; transportEvidenceId: string; requestId: string } } };
    const rpc = details.contextFlow.jsonRpc;
    assert.equal(rpc.role, "result" in payload ? "result" : "error");
    assert.equal(rpc.requestId, "request-1");
    const files = await h.rawFiles();
    assert.equal(files.find((file) => file.name.startsWith(rpc.transportEvidenceId))?.raw, raw);
    const primary = files.find((file) => file.name.startsWith(ref.evidence.slice("evidence://".length)))!.raw;
    assert.deepEqual(JSON.parse(primary), "result" in payload ? payload.result : payload.error);
  }
});

test("hook never replaces source results when initialization, capture, or reference fails", async (t) => {
  for (const method of ["initialize", "captureIntercepted", "reference"] as const) {
    await t.test(method, async (t) => {
      const h = await harness(t);
      t.mock.method(ContextStore.prototype, method, async () => { throw new Error(`injected ${method} failure`); });
      const errors = t.mock.method(console, "error", () => {});
      assert.equal(await h.invoke([text(data), text(log)]), undefined);
      assert.equal(errors.mock.callCount(), 1);
    });
  }
});

for (const [name, raw] of [
  ["comma-rich prose", "This is prose, not data.\nIt contains commas, like normal writing.\nMore explanations, not records.\n" + "Normal prose. ".repeat(800)],
  ["source containing INFO", 'const INFO = "message";\n' + "const value = 42;\n".repeat(600)],
]) test(`review: hook bypasses ${name}`, async (t) => {
  const h = await harness(t);
  assert.ok(Buffer.byteLength(raw) > 8192);
  assert.equal(await h.invoke([text(raw)]), undefined);
  assert.deepEqual(await readdir(h.cwd), []);
});

test("review: captured errors preserve effective error flag and meaningful source details", async (t) => {
  const h = await harness(t);
  const result = await h.invoke([text(log)], "mcp_call", true);
  reference(result);
  assert.equal(result?.isError ?? true, true);
  assert.equal((result?.details as { original?: boolean })?.original, true);
});

test("hook captures unambiguous quoted CSV and TSV with matching shapes", async (t) => {
  const h = await harness(t);
  for (const [shape, raw] of [
    ["csv", 'id,state\n' + '1,"open, pending\ncontinued"\n'.repeat(400)],
    ["tsv", 'id\tstate\n' + '1\topen\n'.repeat(1400)],
  ]) {
    assert.equal(reference(await h.invoke([text(raw)])).type, shape);
    assert.ok((await h.rawFiles()).some((file) => file.raw === raw));
  }
});

test("hook retains severity-prefixed logs and bypasses embedded severity prose", async (t) => {
  const h = await harness(t);
  assert.equal(await h.invoke([text('This prose mentions INFO in a sentence.\n'.repeat(300))]), undefined);
  for (const raw of ['INFO service ready\n'.repeat(500), '[WARN] service retrying\n'.repeat(500)]) {
    assert.equal(reference(await h.invoke([text(raw)])).type, "mixed");
  }
});

test("hook preserves colliding and non-object source details without overwriting source keys", async (t) => {
  const h = await harness(t);
  for (const details of [{ contextFlow: { owner: "source" }, sourceDetails: "original-key", original: true }, ["array-details"], "text-details", null]) {
    const result = await h.invoke([text(data)], "mcp_call", false, details);
    const merged = result?.details as { contextFlow: { captured: boolean; sourceDetails: unknown }; sourceDetails?: string };
    assert.equal(merged.contextFlow.captured, true);
    assert.deepEqual(merged.contextFlow.sourceDetails, details);
    if (details && !Array.isArray(details) && typeof details === "object") assert.equal(merged.sourceDetails, "original-key");
    assert.equal(result?.isError ?? false, false);
  }
});
