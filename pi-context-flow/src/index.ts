import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ContextStore } from "./store.js";
import { ContextOutStore } from "./context-out/store.js";

const MAX_INLINE_BYTES = 8_192;
const MAX_TOOL_TEXT_BYTES = 64 * 1024;
const NATIVE_NAVIGATION_TOOLS = new Set(["read", "grep", "find", "ls"]);

export default function registerContextFlow(pi: ExtensionAPI, options: { home?: string; contextOut?: ContextOutStore } = {}) {
  const contextOut = options.contextOut ?? new ContextOutStore({ home: options.home });
  pi.on("session_shutdown", async () => { await contextOut.close(); });
  const out = (value: unknown) => {
    const json = JSON.stringify(value);
    const bounded = Buffer.byteLength(json) <= 30000 ? value : { version: 1, truncated: true, warning: "Response exceeds budget; request a smaller page or provenance/history section", preview: json.slice(0, 4000) };
    return { content: [{ type: "text" as const, text: JSON.stringify(bounded) }], details: bounded };
  };
  const stores = new Map<string, ContextStore>();
  const storeFor = async (cwd: string) => {
    let store = stores.get(cwd);
    if (!store) { store = new ContextStore(cwd); await store.initialize(); stores.set(cwd, store); }
    return store;
  };
  const output = async (store: ContextStore, evidenceId: string, value: unknown, details: Record<string, unknown> = {}) => {
    const text = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(text, "utf8") <= MAX_TOOL_TEXT_BYTES) return { content: [{ type: "text" as const, text }], details };
    const derived = await store.captureRaw("context_tool_output", { evidenceId }, text, "tool_output");
    const reference = await store.reference(derived.evidenceId);
    return { content: [{ type: "text" as const, text: `Bounded output exceeded ${MAX_TOOL_TEXT_BYTES} bytes and was captured as evidence://${reference.evidenceId}. ${referenceText(reference)}` }], details: { ...details, outputEvidence: reference } };
  };

  pi.on("tool_result", async (event, ctx) => {
    // Context Flow's own bounded results are already controlled; never re-ingest them as evidence.
    if (event.toolName.startsWith("context_") || NATIVE_NAVIGATION_TOOLS.has(event.toolName)) return;
    try {
      const raw = autoCapturePayload(event.content);
      if (raw === undefined) return;
      const store = await storeFor(ctx.cwd);
      const captured = await store.captureIntercepted(event.toolName, event.input, raw, "tool_result_envelope");
      const reference = await store.reference(captured.evidence.evidenceId);
      const capture = { evidence: `evidence://${reference.evidenceId}`, type: reference.shape };
      return { content: [{ type: "text", text: JSON.stringify(capture) }], details: { contextFlow: { captured: true, ...reference, jsonRpc: captured.jsonRpc } } };
    } catch (error) {
      // A tool-result hook must never replace the source result with an extension exception.
      console.error("Context Flow capture failed:", error);
      return;
    }
  });

  pi.registerTool({
    name: "context_capture", label: "Capture Evidence",
    description: "Persist text or JSON evidence locally and return its bounded analysis capabilities.",
    parameters: Type.Object({ tool: Type.String(), arguments: Type.Unknown(), payload: Type.Unknown(), source: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const evidence = await store.capture(params.tool, params.arguments, params.payload, params.source); const reference = await store.reference(evidence.evidenceId); return { content: [{ type: "text", text: `Captured evidence://${reference.evidenceId}. ${referenceText(reference)}` }], details: { evidence: reference } }; },
  });
  pi.registerTool({
    name: "context_capture_file", label: "Capture Workspace Data or Log",
    description: "Capture one workspace-relative regular JSON/data or recognizable log file without reading it into model context. Source and prose files are rejected; use Pi read for those.",
    parameters: Type.Object({ path: Type.String(), kind: Type.Optional(StringEnum(["auto", "data", "log"] as const)) }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const evidence = await store.captureFile(params.path, params.kind); const reference = await store.reference(evidence.evidenceId); return { content: [{ type: "text", text: `Captured evidence://${reference.evidenceId}. ${referenceText(reference)}` }], details: { evidence: reference } }; },
  });
  pi.registerTool({
    name: "context_metadata", label: "Inspect Evidence Metadata",
    description: "Return capture provenance, integrity hash, dependencies, and JSON-RPC transport lineage for one evidence reference.",
    parameters: Type.Object({ evidenceId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); return output(store, params.evidenceId, await store.evidenceMetadata(params.evidenceId), { evidenceId: params.evidenceId }); },
  });
  pi.registerTool({
    name: "context_schema", label: "Inspect Evidence Schema", 
    description: "Return the authoritative DuckDB `evidence` relation schema. Compact is default; request full only for nested-field details. Use the returned examples directly.", parameters: Type.Object({ evidenceId: Type.String(), detail: Type.Optional(StringEnum(["compact", "full"] as const)), maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })), maxNodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const schema = await store.inspectSchema(params.evidenceId, params); return output(store, params.evidenceId, schema, { evidenceId: params.evidenceId }); },
  });
  pi.registerTool({
    name: "context_read", label: "Read Evidence Range",
    description: "Read a strictly bounded JSON path or exact text byte/line range. Large raw evidence cannot be read wholesale.",
    parameters: Type.Object({ evidenceId: Type.String(), jsonPath: Type.Optional(Type.String()), byteStart: Type.Optional(Type.Integer({ minimum: 0 })), byteEnd: Type.Optional(Type.Integer({ minimum: 0 })), lineStart: Type.Optional(Type.Integer({ minimum: 1 })), lineEnd: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const value = params.jsonPath !== undefined ? await store.readJson(params.evidenceId, params.jsonPath) : await store.readText(params.evidenceId, params); return output(store, params.evidenceId, value, { evidenceId: params.evidenceId }); },
  });
  pi.registerTool({
    name: "context_search", label: "Search Evidence Text",
    description: "Run bounded local lexical search over text or mixed evidence. Hybrid semantic search is explicitly unavailable.",
    parameters: Type.Object({ evidenceId: Type.String(), query: Type.String(), mode: Type.Optional(StringEnum(["lexical", "hybrid"] as const)), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const result = await store.searchText(params.evidenceId, params.query, params.mode, params.limit); return output(store, params.evidenceId, result, { evidenceId: params.evidenceId }); },
  });
  pi.registerTool({
    name: "context_query_sql", label: "Query Evidence SQL",
    description: "Run one bounded read-only DuckDB SELECT/WITH query against the schema returned by context_schema. A single trailing semicolon is accepted. Prefer format=json and one JSON-producing SELECT for compact results.", parameters: Type.Object({ evidenceId: Type.String(), sql: Type.String(), format: Type.Optional(StringEnum(["rows", "json"] as const)) }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const result = await store.querySql(params.evidenceId, params.sql, params.format); return output(store, params.evidenceId, { ...(params.format === "json" ? { result: result.result } : { rows: result.rows }), truncated: result.truncated, outputEvidence: result.outputEvidence }, { queryId: result.query.queryId, evidenceId: params.evidenceId }); },
  });
  pi.registerTool({
    name: "context_query_structured", label: "Aggregate Structured Evidence",
    description: "Compile a compact, read-only DuckDB aggregation over a list-of-structs column. Prefer this for filters, groups, and count/sum/min/max; use SQL for other queries.",
    parameters: Type.Object({ evidenceId: Type.String(), listColumn: Type.String(), filters: Type.Optional(Type.Array(Type.Object({ field: Type.String(), equals: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])), oneOf: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { minItems: 1, maxItems: 50 })) }), { maxItems: 10 })), groupBy: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })), aggregates: Type.Optional(Type.Array(Type.Object({ field: Type.String(), op: StringEnum(["count", "sum", "max", "min"] as const), as: Type.String() }), { maxItems: 8 })) }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const result = await store.queryStructured(params.evidenceId, params); return output(store, params.evidenceId, { result: result.result, truncated: result.truncated, outputEvidence: result.outputEvidence }, { queryId: result.query.queryId, evidenceId: params.evidenceId }); },
  });
  pi.registerTool({
    name: "context_query_records", label: "Query Structured Records",
    description: "Opt-in one-turn record lookup for a uniquely named nested LIST-of-STRUCT collection. Resolves only exact collection hints and authoritative scalar paths; no schema guessing or natural-language parsing.",
    parameters: Type.Object({ evidenceId: Type.String(), collectionHint: Type.String({ minLength: 1, maxLength: 128 }), filters: Type.Optional(Type.Array(Type.Object({ field: Type.String({ minLength: 1, maxLength: 256 }), equals: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])), oneOf: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { minItems: 1, maxItems: 50 })) }, { additionalProperties: false }), { maxItems: 10 })), select: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 16 })), orderBy: Type.Optional(Type.Array(Type.Object({ field: Type.String({ minLength: 1, maxLength: 256 }), direction: StringEnum(["asc", "desc"] as const) }, { additionalProperties: false }), { maxItems: 4 })), limit: Type.Integer({ minimum: 1, maximum: 100 }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const result = await store.queryRecords(params.evidenceId, params); return output(store, params.evidenceId, { records: result.records, truncated: result.truncated, outputEvidence: result.outputEvidence }, { queryId: result.query.queryId, evidenceId: params.evidenceId }); },
  });
  pi.registerTool({
    name: "context_query_jq", label: "Query Evidence jq", 
    description: "Run a local jq expression with a five-second timeout and 64KiB output budget.", parameters: Type.Object({ evidenceId: Type.String(), expression: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const result = await store.queryJq(params.evidenceId, params.expression); return output(store, params.evidenceId, { result: result.result, truncated: result.truncated, outputEvidence: result.outputEvidence }, { queryId: result.query.queryId, evidenceId: params.evidenceId }); },
  });
  pi.registerTool({
    name: "context_repl", label: "Sandboxed Evidence REPL",
    description: "Run Python or Bash only in Docker/Podman with no network, host execution, secrets, or writable inputs.",
    parameters: Type.Object({ language: StringEnum(["python", "bash"] as const), code: Type.String(), evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })), workspacePaths: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })) }),
    async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); const result = await store.repl(params); return output(store, result.outputEvidence?.evidenceId ?? "repl", result, { invocationId: result.invocationId }); },
  });

  const retryKey = Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }));
  const scope = Type.Optional(StringEnum(["worktree", "repository"] as const));
  const pageParameters = { scope, query: Type.Optional(Type.String({ maxLength: 1024 })), history: Type.Optional(Type.Boolean()),
    branch: Type.Optional(Type.String()), revision: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), scanLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) };
  pi.registerTool({ name: "context_observe", label: "Record Observation", description: "Commit a durable conclusion and local evidence/query snapshots. Git required. Retry key defaults to tool invocation ID; reuse it for uncertain commits. No raw copying.",
    parameters: Type.Object({ text: Type.String(), category: StringEnum(["decision", "constraint", "failed_approach", "relationship", "unresolved_work", "operational_knowledge", "other"] as const), evidenceIds: Type.Array(Type.String(), { maxItems: 128 }), queryIds: Type.Array(Type.String(), { maxItems: 128 }), retryKey }),
    async execute(id, params, _signal, _update, ctx) { return out(await contextOut.observe(ctx.cwd, ctx.sessionManager.getSessionId(), params.retryKey ?? id, params, () => storeFor(ctx.cwd))); } });
  pi.registerTool({ name: "context_promote", label: "Propose Artifact", description: "Commit a pending artifact proposal for an active owned observation. Never approves knowledge, changes visibility, or writes an artifact.",
    parameters: Type.Object({ observationId: Type.String(), scope: StringEnum(["repo", "architecture", "organization"] as const), target: Type.String(), rationale: Type.String(), retryKey }),
    async execute(id, params, _signal, _update, ctx) { return out(await contextOut.promote(ctx.cwd, ctx.sessionManager.getSessionId(), params.retryKey ?? id, params)); } });
  pi.registerTool({ name: "context_search_observations", label: "Search Observations", description: "Bounded lexical search; worktree default, repository explicitly cross-origin. No age cutoff. History opt-in; cursor invalidates on new events. At most 1000 rows/1MiB scanned, 2 seconds querying, 64KiB response. Replay is not bounded by these query budgets.",
    parameters: Type.Object(pageParameters), async execute(_id, params, _signal, _update, ctx) { return out(await contextOut.search(ctx.cwd, params)); } });
  pi.registerTool({ name: "context_read_observation", label: "Read Observation", description: "Read one scoped claim including lifecycle and recorded origin. Optional support inspection hashes fixed local raw files (8MiB/2 seconds); cross-origin support remains unverified or unavailable. At most 64KiB response.",
    parameters: Type.Object({ observationId: Type.String(), scope, assess: Type.Optional(Type.Boolean()) }), async execute(_id, params, _signal, _update, ctx) { return out(await contextOut.read(ctx.cwd, params.observationId, params)); } });
  pi.registerTool({ name: "context_inspect_observation", label: "Inspect Observation Provenance", description: "Inspect immutable provenance snapshots or event history in JSON-text chunks. Character offset pagination, 2000 characters per chunk, <=64KiB response. Query definitions may contain sensitive literals. No raw evidence content.",
    parameters: Type.Object({ observationId: Type.String(), scope, section: StringEnum(["provenance", "history"] as const), offset: Type.Optional(Type.Integer({ minimum: 0 })) }), async execute(_id, params, _signal, _update, ctx) { return out(await contextOut.inspect(ctx.cwd, params.observationId, params)); } });
  pi.registerTool({ name: "context_observation_lifecycle", label: "Change Observation Lifecycle", description: "Explicitly retract, supersede, or link another supporting observation. Requires current head event as predecessor and same-worktree active ownership. Does not approve or delete anything.",
    parameters: Type.Object({ observationId: Type.String(), action: StringEnum(["retract", "supersede", "link_support"] as const), predecessorEventId: Type.String(), relatedObservationId: Type.Optional(Type.String()), reason: Type.Optional(Type.String()), retryKey }),
    async execute(id, params, _signal, _update, ctx) { return out(await contextOut.lifecycle(ctx.cwd, ctx.sessionManager.getSessionId(), params.retryKey ?? id, params)); } });
  pi.registerTool({ name: "context_candidate_inbox", label: "List Candidate Proposals", description: "Bounded proposal-only inbox. Worktree default; explicit repository scope. Status proposed means pending review, never approved. No 21-day exclusion. At most 64KiB response.",
    parameters: Type.Object(pageParameters), async execute(_id, params, _signal, _update, ctx) { return out(await contextOut.search(ctx.cwd, params, true)); } });
  pi.registerTool({ name: "context_migrate_legacy", label: "Migrate Legacy Context Out", description: "Explicit selected-worktree legacy dry-run/import. Does not initialize the legacy store, delete tables, or copy raw content. Close legacy writers first. Imports only consistent ledger-backed records; unresolved lineage is reported. Repeated import is idempotent. At most 64KiB response.",
    parameters: Type.Object({ mode: StringEnum(["dry-run", "import"] as const) }), async execute(_id, params, _signal, _update, ctx) { return out(await contextOut.migrate(ctx.cwd, params.mode)); } });
  pi.registerTool({ name: "context_get_evidence", label: "Get Bounded Evidence Preview", description: "Compatibility tool: retrieve at most 16KiB of evidence. Use context_read for exact ranges.", parameters: Type.Object({ evidenceId: Type.String(), maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })) }), async execute(_id, params, _signal, _update, ctx) { const store = await storeFor(ctx.cwd); return output(store, params.evidenceId, await store.getEvidence(params.evidenceId, params.maxBytes), { evidenceId: params.evidenceId }); } });
}

export function serializeToolContent(content: unknown): string | undefined {
  // JSON preserves text chunk boundaries and any safely serializable non-text payload without inventing separators.
  try { return JSON.stringify({ version: 1, content }) + "\n"; } catch { return undefined; }
}

function autoCapturePayload(content: unknown): string | undefined {
  // Only plain, dense arrays of supported text blocks are safe to replace. Reject
  // accessors, custom serialization, and extra fields rather than silently losing them.
  if (!Array.isArray(content) || Object.getPrototypeOf(content) !== Array.prototype || !content.length) return undefined;
  if (Reflect.ownKeys(content).length !== content.length + 1) return undefined;
  const texts: string[] = [];
  for (let index = 0; index < content.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(content, String(index));
    if (!entry || !("value" in entry) || !entry.enumerable) return undefined;
    const item: unknown = entry.value;
    if (!item || typeof item !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return undefined;
    const fields = Object.getOwnPropertyDescriptors(item);
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== "string" || !["type", "text", "textSignature"].includes(key)) return undefined;
      const field = fields[key];
      if (!("value" in field) || !field.enumerable || typeof field.value !== "string") return undefined;
    }
    if (fields.type?.value !== "text" || typeof fields.text?.value !== "string") return undefined;
    texts.push(fields.text.value);
  }
  // Envelope overhead must not push small source results over the threshold, and
  // one qualifying item must not hide unrelated prose/source in another item.
  if (texts.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0) <= MAX_INLINE_BYTES || !texts.every(shouldAutoCapture)) return undefined;
  // Keep single-text JSON/JSON-RPC transport behavior; multiple blocks retain
  // their exact order, whitespace, signatures, and chunk boundaries in the envelope.
  return texts.length === 1 ? texts[0] : serializeToolContent(content);
}

function referenceText(reference: { source: string; sizeBytes: number; shape: string; timestamp: string; tools: string[] }): string { return `Source: ${reference.source}; size: ${reference.sizeBytes} bytes; shape: ${reference.shape}; captured ${reference.timestamp}. Available Context In tools: ${reference.tools.join(", ")}.`; }

export function shouldAutoCapture(raw: string): boolean {
  try { JSON.parse(raw); return true; } catch { /* fall through */ }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const jsonLines = lines.filter((line) => { try { JSON.parse(line); return true; } catch { return false; } }).length;
  const delimited = lines.length >= 2 && [",", "\t"].some((delimiter) => lines.slice(0, 3).every((line) => line.includes(delimiter)));
  const xml = /^\s*<\?xml(?:\s|\?>)/u.test(raw);
  const yaml = /^(?:---\s*$|[A-Za-z_][\w-]*:\s*(?:[^\n]*)$)/m.test(raw);
  return jsonLines > 0 || delimited || xml || yaml || /^(?:\d{4}-\d\d-\d\d|\[[^\]]+\])|\b(?:ERROR|WARN|INFO|DEBUG)\b/m.test(raw);
}
