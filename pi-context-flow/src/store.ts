import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import duckdb from "duckdb";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseDocument } from "yaml";
import { analyzeSql } from "./sql-analysis.js";
import { createId, timestamp } from "./ids.js";
import type { ArtifactCandidate, EvidenceMetadata, EvidenceReference, EvidenceShape, Observation } from "./types.js";

const MAX_READ_BYTES = 16 * 1024;
const MAX_ROWS = 200;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_JQ_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_SQL_BYTES = 16 * 1024;
const REPL_TIMEOUT_MS = 10_000;
const SAFE_COMMAND_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin" };
const CHUNK_BYTES = 4 * 1024;
const SEARCH_PAGE_CHUNKS = 64;
const MAX_SEARCH_CHUNKS = 4096;
const MAX_SEARCH_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 64 * 1024;
const MAX_SEARCH_QUERY_BYTES = 1024;
const MAX_SEARCH_TERMS = 32;
const SEARCH_TIMEOUT_MS = 2_000;
const MAX_REPL_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_STRUCTURED_PARSE_NODES = 100_000;
const MAX_STRUCTURED_PARSE_DEPTH = 100;
const execFile = promisify(execFileCallback);
const JQ_PATH = findExecutable("jq");

type QueryRecord = { queryId: string; evidenceId: string; language: "sql" | "jq"; query: string; timestamp: string };
type Row = Record<string, unknown>;
export type InterceptedCapture = {
  evidence: EvidenceMetadata;
  jsonRpc?: { role: "result" | "error"; transportEvidenceId: string; requestId?: string | number | null };
};
type ScalarValue = string | number | boolean;
type RecordFilter = { field: string; equals?: ScalarValue; oneOf?: ScalarValue[] };
type RecordOrder = { field: string; direction: "asc" | "desc" };
export type QueryRecordsInput = { collectionHint: string; filters?: RecordFilter[]; select?: string[]; orderBy?: RecordOrder[]; limit: number };
type DuckType = { kind: "scalar"; type: string } | { kind: "struct"; fields: Map<string, DuckType> } | { kind: "list"; child: DuckType };
type RecordCollection = { path: string[]; item: Extract<DuckType, { kind: "struct" }> };

type BoundedResult<T> = { value: T; truncated: boolean; bytes: number };
type StagedCommandResult = { path: string; directory: string; exitCode: number | null; timedOut: boolean; outputLimitReached: boolean };

export class ContextStore {
  readonly root: string;
  private readonly rawDirectory: string;
  private readonly queryDirectory: string;
  private readonly dbPath: string;
  private readonly cwd: string;
  private database?: duckdb.Database;
  private connection?: duckdb.Connection;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.root = join(this.cwd, ".pi", "context");
    this.rawDirectory = join(this.root, "evidence", "raw");
    this.queryDirectory = join(this.root, "queries");
    this.dbPath = join(this.root, "state.duckdb");
  }

  async initialize(): Promise<void> {
    await mkdir(this.rawDirectory, { recursive: true });
    await mkdir(this.queryDirectory, { recursive: true });
    await this.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id VARCHAR PRIMARY KEY, tool VARCHAR NOT NULL, arguments_json VARCHAR NOT NULL,
        timestamp VARCHAR NOT NULL, source VARCHAR NOT NULL, raw_path VARCHAR NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0, shape VARCHAR NOT NULL DEFAULT 'json',
        sha256 VARCHAR NOT NULL DEFAULT '',
        dependencies_json VARCHAR NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS text_chunks (
        evidence_id VARCHAR NOT NULL, chunk_index INTEGER NOT NULL, byte_start BIGINT NOT NULL,
        byte_end BIGINT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, text VARCHAR NOT NULL,
        PRIMARY KEY (evidence_id, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS mixed_json_lines (
        evidence_id VARCHAR NOT NULL, line INTEGER NOT NULL, byte_start BIGINT NOT NULL DEFAULT 0,
        byte_end BIGINT NOT NULL DEFAULT 0, line_start INTEGER NOT NULL DEFAULT 1,
        line_end INTEGER NOT NULL DEFAULT 1, json VARCHAR NOT NULL,
        PRIMARY KEY (evidence_id, line)
      );
      CREATE TABLE IF NOT EXISTS evidence_queries (
        query_id VARCHAR PRIMARY KEY, evidence_id VARCHAR NOT NULL, language VARCHAR NOT NULL,
        query_text VARCHAR NOT NULL, timestamp VARCHAR NOT NULL, output_evidence_id VARCHAR
      );
      CREATE TABLE IF NOT EXISTS derived_materializations (
        materialization_id VARCHAR PRIMARY KEY, evidence_id VARCHAR NOT NULL, kind VARCHAR NOT NULL,
        source_range VARCHAR, details_json VARCHAR NOT NULL, timestamp VARCHAR NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repl_invocations (
        invocation_id VARCHAR PRIMARY KEY, evidence_ids_json VARCHAR NOT NULL, workspace_paths_json VARCHAR NOT NULL,
        language VARCHAR NOT NULL, code VARCHAR NOT NULL, limits_json VARCHAR NOT NULL, timestamp VARCHAR NOT NULL,
        exit_code INTEGER, output_evidence_id VARCHAR, status VARCHAR NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (observation_id VARCHAR PRIMARY KEY, text VARCHAR NOT NULL, category VARCHAR NOT NULL, timestamp VARCHAR NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_evidence (observation_id VARCHAR NOT NULL, evidence_id VARCHAR NOT NULL, query_id VARCHAR);
      CREATE TABLE IF NOT EXISTS artifact_candidates (candidate_id VARCHAR PRIMARY KEY, observation_id VARCHAR NOT NULL, scope VARCHAR NOT NULL, target VARCHAR NOT NULL, rationale VARCHAR NOT NULL, timestamp VARCHAR NOT NULL, status VARCHAR NOT NULL);
    `);
    // Support caches created by the original POC before the extra provenance columns existed.
    for (const sql of [
      "ALTER TABLE evidence ADD COLUMN IF NOT EXISTS size_bytes BIGINT DEFAULT 0",
      "ALTER TABLE evidence ADD COLUMN IF NOT EXISTS shape VARCHAR DEFAULT 'json'",
      "ALTER TABLE evidence ADD COLUMN IF NOT EXISTS sha256 VARCHAR DEFAULT ''",
      "ALTER TABLE evidence ADD COLUMN IF NOT EXISTS dependencies_json VARCHAR DEFAULT '[]'",
      "ALTER TABLE evidence_queries ADD COLUMN IF NOT EXISTS output_evidence_id VARCHAR",
      "ALTER TABLE mixed_json_lines ADD COLUMN IF NOT EXISTS byte_start BIGINT DEFAULT 0",
      "ALTER TABLE mixed_json_lines ADD COLUMN IF NOT EXISTS byte_end BIGINT DEFAULT 0",
      "ALTER TABLE mixed_json_lines ADD COLUMN IF NOT EXISTS line_start INTEGER DEFAULT 1",
      "ALTER TABLE mixed_json_lines ADD COLUMN IF NOT EXISTS line_end INTEGER DEFAULT 1",
    ]) await this.exec(sql);
  }

  async capture(tool: string, args: unknown, payload: unknown, source = "tool_result"): Promise<EvidenceMetadata> {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) + "\n";
    return this.captureRaw(tool, args, raw, source);
  }

  async captureIntercepted(tool: string, args: unknown, raw: string, source = "tool_result_envelope"): Promise<InterceptedCapture> {
    const rpc = parseJsonRpcResponse(raw);
    if (!rpc) return { evidence: await this.captureRaw(tool, args, raw, source) };
    // Preserve the exact transport response, then make its result/error the primary evidence.
    const transport = await this.captureRaw(tool, args, raw, source);
    const role = rpc.error === undefined ? "result" : "error";
    const payload = role === "result" ? rpc.result : rpc.error;
    const evidence = await this.captureRaw(tool, { ...asRecord(args), jsonRpc: { transportEvidenceId: transport.evidenceId, role, requestId: rpc.id ?? null } }, JSON.stringify(payload, null, 2) + "\n", `jsonrpc_${role}`);
    await this.run("UPDATE evidence SET dependencies_json = ? WHERE evidence_id = ?", [JSON.stringify([transport.evidenceId]), evidence.evidenceId]);
    return { evidence: { ...evidence, dependencies: [transport.evidenceId] }, jsonRpc: { role, transportEvidenceId: transport.evidenceId, requestId: rpc.id ?? null } };
  }

  async captureFile(path: string, kind: "auto" | "data" | "log" = "auto"): Promise<EvidenceMetadata> {
    if (!path || isAbsolute(path)) throw new Error("Capture paths must be non-empty and workspace-relative.");
    const workspace = await realpath(this.cwd);
    const requested = resolve(workspace, path);
    const absolute = await realpath(requested);
    assertCaptureWorkspacePathAllowed(workspace, absolute);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("Only regular workspace files may be captured.");
    if (info.size > MAX_ARTIFACT_BYTES) throw new Error(`Capture files must be at most ${MAX_ARTIFACT_BYTES} bytes.`);
    const raw = await readFile(absolute, "utf8");
    if (Buffer.byteLength(raw, "utf8") !== info.size) throw new Error("Binary files cannot be captured as text evidence.");
    const shape = classify(raw, absolute);
    if (kind === "data" && !isStructuredShape(shape)) throw new Error("data capture requires JSON, CSV, TSV, XML, or YAML; use log for log-like text.");
    if (kind === "log" && shape !== "mixed") throw new Error("log capture requires JSONL or recognizable log-like text.");
    if (kind === "auto" && shape === "text") throw new Error("Unsupported text artifact. Use Pi read for source or prose; capture data or logs only.");
    return this.captureRaw("context_capture_file", { path }, raw, `workspace_file:${relative(this.cwd, absolute).replaceAll(sep, "/")}`, shape);
  }

  async captureRaw(tool: string, args: unknown, raw: string, source = "tool_result", shapeOverride?: EvidenceShape): Promise<EvidenceMetadata> {
    const evidenceId = createId("evidence");
    const shape = shapeOverride ?? classify(raw);
    const rawPath = join(this.rawDirectory, `${evidenceId}.${shape === "json" ? "json" : "txt"}`);
    const capturedAt = timestamp();
    const bytes = Buffer.byteLength(raw, "utf8");
    const metadata: EvidenceMetadata = { evidenceId, tool, arguments: args, timestamp: capturedAt, source, rawPath, sizeBytes: bytes, shape, sha256: createHash("sha256").update(raw).digest("hex"), dependencies: [] };
    await writeFile(rawPath, raw, "utf8");
    await this.run("INSERT INTO evidence (evidence_id, tool, arguments_json, timestamp, source, raw_path, size_bytes, shape, sha256, dependencies_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [evidenceId, tool, JSON.stringify(args), capturedAt, source, rawPath, bytes, shape, metadata.sha256, "[]"]);
    if (shape !== "json") await this.indexText(metadata, raw);
    if (shape === "mixed") await this.indexMixed(metadata, raw);
    return metadata;
  }

  async reference(evidenceId: string): Promise<EvidenceReference> { return this.referenceFor(await this.metadata(normalizeEvidenceId(evidenceId))); }

  async evidenceMetadata(evidenceId: string): Promise<{ evidence: string; type: EvidenceShape; source: string; sizeBytes: number; capturedAt: string; sha256: string; dependencies: string[]; jsonRpc?: { role: "result" | "error"; requestId: string | number | null; transportEvidence: string } }> {
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    const jsonRpc = metadata.arguments && typeof metadata.arguments === "object" && !Array.isArray(metadata.arguments) ? (metadata.arguments as Record<string, unknown>).jsonRpc : undefined;
    const rpc = jsonRpc && typeof jsonRpc === "object" && !Array.isArray(jsonRpc) ? jsonRpc as Record<string, unknown> : undefined;
    const role = rpc?.role === "result" || rpc?.role === "error" ? rpc.role : undefined;
    const transportEvidenceId = typeof rpc?.transportEvidenceId === "string" ? rpc.transportEvidenceId : undefined;
    const requestId = typeof rpc?.requestId === "string" || typeof rpc?.requestId === "number" || rpc?.requestId === null ? rpc.requestId : null;
    return { evidence: `evidence://${metadata.evidenceId}`, type: metadata.shape, source: metadata.source, sizeBytes: metadata.sizeBytes, capturedAt: metadata.timestamp, sha256: metadata.sha256, dependencies: metadata.dependencies.map((id) => `evidence://${id}`), ...(role && transportEvidenceId ? { jsonRpc: { role, requestId, transportEvidence: `evidence://${transportEvidenceId}` } } : {}) };
  }

  async describeRelation(evidenceId: string, detail: "compact" | "full" = "compact"): Promise<RelationDescription> {
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    if (!isStructuredShape(metadata.shape) && metadata.shape !== "mixed") throw new Error("DuckDB relations are available only for structured or mixed evidence.");
    const description = await describeEvidenceRelation(metadata, detail);
    return { ...description };
  }

  async getEvidence(evidenceId: string, maxBytes = MAX_READ_BYTES): Promise<{ metadata: EvidenceMetadata; payload: unknown; truncated: boolean }> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) throw new Error(`maxBytes must be between 1 and ${MAX_READ_BYTES}.`);
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    const raw = await readFile(metadata.rawPath);
    const limited = raw.subarray(0, maxBytes);
    const text = limited.toString("utf8");
    return { metadata, payload: metadata.shape === "json" && limited.length === raw.length ? JSON.parse(text) : text, truncated: limited.length < raw.length };
  }

  async inspectSchema(evidenceId: string, budget: { maxDepth?: number; maxNodes?: number; detail?: "compact" | "full" } = {}): Promise<unknown> {
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    if (isStructuredShape(metadata.shape) || metadata.shape === "mixed") return this.describeRelation(metadata.evidenceId, budget.detail);
    const maxDepth = budget.maxDepth ?? 6; const maxNodes = budget.maxNodes ?? 200;
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20 || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 1_000) throw new Error("Schema maxDepth must be 0-20 and maxNodes 1-1000.");
    return { relation: undefined, schema: [{ path: "$", type: "text", chunks: await this.chunkCount(metadata.evidenceId) }] };
  }

  async readText(evidenceId: string, input: { byteStart?: number; byteEnd?: number; lineStart?: number; lineEnd?: number }): Promise<{ text: string; byteStart: number; byteEnd: number; lineStart: number; lineEnd: number; truncated: boolean }> {
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    if (isStructuredShape(metadata.shape)) throw new Error("Use context_schema and context_query_sql for structured evidence.");
    const raw = await readFile(metadata.rawPath);
    let start = input.byteStart ?? 0;
    let end = input.byteEnd ?? raw.length;
    if (input.lineStart !== undefined || input.lineEnd !== undefined) {
      const lines = lineRanges(raw);
      const first = Math.max(1, input.lineStart ?? 1);
      const last = Math.min(lines.length, input.lineEnd ?? first + 199);
      if (last < first) throw new Error("Invalid line range.");
      start = lines[first - 1]?.start ?? raw.length;
      end = lines[last - 1]?.end ?? raw.length;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start > raw.length) throw new Error("Invalid byte range.");
    end = Math.min(raw.length, end, start + MAX_READ_BYTES);
    const ranges = lineRanges(raw);
    return { text: raw.subarray(start, end).toString("utf8"), byteStart: start, byteEnd: end, lineStart: lineAt(ranges, start), lineEnd: lineAt(ranges, Math.max(start, end - 1)), truncated: end < (input.byteEnd ?? raw.length) };
  }

  async readJson(evidenceId: string, path = "$"): Promise<{ value: unknown; truncated: boolean; bytes: number }> {
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    if (metadata.shape !== "json") throw new Error("JSON path reads require JSON evidence.");
    const value = jsonPath(JSON.parse(await readFile(metadata.rawPath, "utf8")), path);
    const result = bounded(value, MAX_READ_BYTES);
    return { value: result.value, truncated: result.truncated, bytes: result.bytes };
  }

  async searchText(evidenceId: string, query: string, mode: "lexical" | "hybrid" = "lexical", limit = 20): Promise<{ hits: Row[]; mode: "lexical"; complete: boolean; truncated: boolean; scannedChunks: number; scannedBytes: number; incompleteReason?: string }> {
    const deadline = performance.now() + SEARCH_TIMEOUT_MS;
    const checkDeadline = () => {
      if (performance.now() >= deadline) throw new Error(`Lexical search exceeded its ${SEARCH_TIMEOUT_MS}ms execution budget; no exhaustive result is available.`);
    };
    // Bound caller latency even when the shared database is busy. Only the current
    // bounded page may finish afterward; no further pages or scoring are scheduled.
    const withinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
      checkDeadline();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Lexical search exceeded its ${SEARCH_TIMEOUT_MS}ms execution budget; no exhaustive result is available.`)), Math.max(1, deadline - performance.now()));
        })]);
      } finally { clearTimeout(timer); }
    };
    if (mode === "hybrid") throw new Error("Hybrid search is unavailable: no local semantic index is configured.");
    if (mode !== "lexical") throw new Error("Unknown search mode.");
    if (typeof query !== "string") throw new Error("Search query is required.");
    if (query.length > MAX_SEARCH_QUERY_BYTES || Buffer.byteLength(query) > MAX_SEARCH_QUERY_BYTES) throw new Error(`Search query exceeds ${MAX_SEARCH_QUERY_BYTES} bytes.`);
    if (!query.trim()) throw new Error("Search query is required.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be between 1 and 50.");
    const terms = tokenize(query);
    if (!terms.length) throw new Error("Search query contains no lexical terms.");
    if (terms.length > MAX_SEARCH_TERMS) throw new Error(`Search query exceeds ${MAX_SEARCH_TERMS} lexical terms.`);
    const patterns = terms.map((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "i"));
    const id = normalizeEvidenceId(evidenceId);
    await withinDeadline(this.metadata(id));
    const hits: Row[] = [];
    const compare = (a: Row, b: Row) => Number(b.score) - Number(a.score) || Number(a.chunk_index) - Number(b.chunk_index);
    let cursor = -1, scannedChunks = 0, scannedBytes = 0, matches = 0;
    let complete = false;
    let incompleteReason: string | undefined;
    search: while (true) {
      checkDeadline();
      const rows = await withinDeadline(this.all("SELECT chunk_index, byte_start, byte_end, line_start, line_end, text FROM text_chunks WHERE evidence_id = ? AND chunk_index > ? ORDER BY chunk_index LIMIT ?", [id, cursor, SEARCH_PAGE_CHUNKS]));
      for (const row of rows as Row[]) {
        checkDeadline();
        const bytes = Number(row.byte_end) - Number(row.byte_start);
        if (scannedChunks >= MAX_SEARCH_CHUNKS || scannedBytes + bytes > MAX_SEARCH_SCAN_BYTES) {
          incompleteReason = "Lexical scan budget exhausted (4096 chunks / 16 MiB); ranking covers only scanned chunks.";
          break search;
        }
        scannedChunks++; scannedBytes += bytes; cursor = Number(row.chunk_index);
        const score = patterns.reduce((total, pattern) => total + Number(pattern.test(String(row.text))), 0);
        if (!score) continue;
        matches++;
        const candidate: Row = {
          chunk_index: Number(row.chunk_index), byte_start: Number(row.byte_start), byte_end: Number(row.byte_end),
          line_start: Number(row.line_start), line_end: Number(row.line_end), text: String(row.text), score,
        };
        // Keep only top-k candidates, not every common-term match.
        if (hits.length < limit) hits.push(candidate);
        else if (compare(candidate, hits[hits.length - 1]) < 0) hits[hits.length - 1] = candidate;
        else continue;
        hits.sort(compare);
      }
      if (rows.length < SEARCH_PAGE_CHUNKS) { complete = true; break; }
    }
    const result = { hits, mode: "lexical" as const, complete, truncated: !complete || matches > hits.length, scannedChunks, scannedBytes, ...(incompleteReason ? { incompleteReason } : {}) };
    // Bound the actual JSON response including escaping and provenance; never cut
    // supporting text mid-chunk, since its byte/line ranges must remain exact.
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_SEARCH_RESPONSE_BYTES && hits.length) {
      hits.pop(); result.truncated = true;
    }
    checkDeadline();
    return result;
  }

  async querySql(evidenceId: string, sql: string, format: "rows" | "json" = "rows"): Promise<{ query: QueryRecord; rows: unknown[]; result?: unknown; outputEvidence?: EvidenceReference; truncated: boolean }> {
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    if (!isStructuredShape(metadata.shape) && metadata.shape !== "mixed") throw new Error("SQL is available only for structured or derived mixed evidence.");
    const normalizedSql = normalizeSql(sql); validateSql(normalizedSql);
    const query = this.queryRecord(evidenceId, "sql", normalizedSql);
    await writeFile(join(this.queryDirectory, `${query.queryId}.sql`), normalizedSql + "\n");
    const rows = jsonSafe(await queryEvidenceInMemory(metadata, normalizedSql)) as unknown[];
    const result = bounded(rows.slice(0, MAX_ROWS), MAX_QUERY_BYTES);
    const outputEvidence = result.truncated || rows.length > MAX_ROWS ? await this.captureDerived(evidenceId, query.queryId, "sql_output", stringify({ rows, truncated: true, scope: "retained SQL preview, not the complete query result" }), "sql output") : undefined;
    await this.recordQuery(query, outputEvidence?.evidenceId);
    const returnedRows = (result.truncated ? [result.value] : result.value) as unknown[];
    const compact = format === "json" ? (returnedRows.length === 1 && returnedRows[0] && typeof returnedRows[0] === "object" ? compactJsonResult(returnedRows[0] as Record<string, unknown>) : returnedRows) : undefined;
    return { query, rows: format === "rows" ? returnedRows : [], result: compact, outputEvidence: outputEvidence ? this.referenceFor(outputEvidence) : undefined, truncated: result.truncated || rows.length > MAX_ROWS };
  }

  async queryStructured(evidenceId: string, input: { listColumn: string; filters?: Array<{ field: string; equals?: string | number | boolean; oneOf?: Array<string | number | boolean> }>; groupBy?: string[]; aggregates?: Array<{ field: string; op: "count" | "sum" | "max" | "min"; as: string }> }): ReturnType<ContextStore["querySql"]> {
    const identifier = (value: string) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Structured query identifiers must contain only letters, digits, and underscores.");
      return `item.\"${value}\"`;
    };
    const list = input.listColumn;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(list)) throw new Error("Structured query listColumn must be an identifier.");
    const filters = input.filters ?? []; const groupBy = input.groupBy ?? []; const aggregates = input.aggregates ?? [{ field: "*", op: "count" as const, as: "count" }];
    if (filters.length > 10 || groupBy.length > 8 || aggregates.length > 8) throw new Error("Structured query exceeds its filter, group, or aggregate limit.");
    const where = filters.length ? ` WHERE ${filters.map((filter) => {
      if (filter.oneOf?.length) return `${identifier(filter.field)} IN (${filter.oneOf.map(sqlLiteral).join(", ")})`;
      if (filter.equals === undefined) throw new Error("Structured query filters require equals or oneOf.");
      return `${identifier(filter.field)} = ${sqlLiteral(filter.equals)}`;
    }).join(" AND ")}` : "";
    const groups = groupBy.map(identifier); const selects = [...groups.map((field, index) => `${field} AS \"${groupBy[index]}\"`), ...aggregates.map((aggregate) => `${aggregate.op.toUpperCase()}(${aggregate.field === "*" ? "*" : identifier(aggregate.field)}) AS \"${safeAlias(aggregate.as)}\"`)];
    const sql = `SELECT ${selects.join(", ")} FROM evidence, unnest(\"${list}\") AS t(item)${where}${groups.length ? ` GROUP BY ${groups.join(", ")}` : ""}`;
    return this.querySql(evidenceId, sql, "json");
  }

  async queryRecords(evidenceId: string, input: QueryRecordsInput): Promise<{ query: QueryRecord; records: unknown[]; outputEvidence?: EvidenceReference; truncated: boolean }> {
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    if (!isStructuredShape(metadata.shape) && metadata.shape !== "mixed") throw new Error("Record queries are available only for structured or mixed evidence.");
    validateRecordRequest(input);
    const collections = await recordCollections(metadata);
    const matching = collections.filter((collection) => collection.path.at(-1) === input.collectionHint);
    if (!matching.length) throw new Error(`No LIST-of-STRUCT collection matches ${JSON.stringify(input.collectionHint)}. Candidates: ${compactPaths(collections.map((collection) => collection.path.join(".")))}.`);
    if (matching.length > 1) throw new Error(`Collection hint ${JSON.stringify(input.collectionHint)} is ambiguous. Candidates: ${compactPaths(matching.map((collection) => collection.path.join(".")))}.`);
    const collection = matching[0];
    const scalarFields = scalarFieldMap(collection.item);
    const resolveField = (field: string, purpose: string): Extract<DuckType, { kind: "scalar" }> => {
      const type = scalarFields.get(field);
      if (!type || type.kind !== "scalar") throw new Error(`${purpose} field ${JSON.stringify(field)} is not a scalar path. Scalar fields: ${compactPaths([...scalarFields.keys()])}.`);
      return type;
    };
    const filters = input.filters ?? [];
    const selected = input.select;
    const orderBy = input.orderBy ?? [];
    for (const filter of filters) {
      const type = resolveField(filter.field, "Filter");
      const values = filter.oneOf ?? [filter.equals as ScalarValue];
      for (const value of values) validateScalarValue(value, type, filter.field);
    }
    for (const field of selected ?? []) resolveField(field, "Select");
    for (const order of orderBy) resolveField(order.field, "Order-by");

    const itemField = (field: string) => `item.${field.split(".").map(quoteIdentifier).join(".")}`;
    const relation = collection.path.map(quoteIdentifier).join(".");
    const select = selected?.length
      ? selected.map((field) => `${itemField(field)} AS ${quoteIdentifier(field)}`).join(", ")
      : "item AS record";
    const where = filters.length ? ` WHERE ${filters.map((filter) => {
      const field = itemField(filter.field);
      return filter.oneOf ? `${field} IN (${filter.oneOf.map(sqlLiteral).join(", ")})` : `${field} = ${sqlLiteral(filter.equals as ScalarValue)}`;
    }).join(" AND ")}` : "";
    const order = orderBy.length ? ` ORDER BY ${orderBy.map((item) => `${itemField(item.field)} ${item.direction.toUpperCase()}`).join(", ")}` : "";
    const result = await this.querySql(metadata.evidenceId, `SELECT ${select} FROM evidence CROSS JOIN UNNEST(${relation}) AS records(item)${where}${order} LIMIT ${input.limit}`, "rows");
    // querySql returns a bounded preview marker when a response exceeds its shared output budget.
    return { query: result.query, records: result.truncated ? result.rows : result.rows.map((row) => selected?.length ? row : (row as Row).record), outputEvidence: result.outputEvidence, truncated: result.truncated };
  }

  async queryJq(evidenceId: string, expression: string): Promise<{ query: QueryRecord; result: unknown; outputEvidence?: EvidenceReference; truncated: boolean }> {
    const metadata = await this.metadata(normalizeEvidenceId(evidenceId));
    if (metadata.shape !== "json") throw new Error("jq is available only for JSON evidence.");
    const query = this.queryRecord(evidenceId, "jq", expression);
    if (!JQ_PATH) throw new Error("jq is unavailable on PATH.");
    const staged = await stageCommand(JQ_PATH, [expression, metadata.rawPath], {
      cwd: this.cwd, env: SAFE_COMMAND_ENV, timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: MAX_ARTIFACT_BYTES,
    });
    try {
      if (staged.timedOut) throw new Error("jq exceeded its 5s execution timeout.");
      if (staged.exitCode !== 0 && !staged.outputLimitReached) throw new Error(`jq failed with exit code ${staged.exitCode ?? "unknown"}.`);
      const raw = await readFile(staged.path, "utf8");
      const output = boundedText(raw, MAX_JQ_BYTES);
      const outputEvidence = output.truncated || staged.outputLimitReached
        ? await this.captureDerived(evidenceId, query.queryId, "jq_output", raw, staged.outputLimitReached ? "jq output (partial: artifact limit reached)" : "jq output")
        : undefined;
      await writeFile(join(this.queryDirectory, `${query.queryId}.jq`), expression + "\n");
      await this.recordQuery(query, outputEvidence?.evidenceId);
      // A clipped jq document is not valid derived data. Return only a marked preview in that case.
      const result = output.truncated || staged.outputLimitReached
        ? { truncated: true, complete: false, preview: output.text }
        : raw.trim() ? JSON.parse(raw) : null;
      return { query, result, outputEvidence: outputEvidence ? this.referenceFor(outputEvidence) : undefined, truncated: output.truncated || staged.outputLimitReached };
    } finally { await rm(staged.directory, { recursive: true, force: true }); }
  }

  async repl(input: { language: "python" | "bash"; code: string; evidenceIds?: string[]; workspacePaths?: string[] }): Promise<{ available: boolean; invocationId?: string; exitCode?: number; output?: string; outputEvidence?: EvidenceReference; reason?: string }> {
    const runtime = await containerRuntime();
    if (!runtime) return { available: false, reason: "Docker or Podman is required; host execution is never used." };
    if (!input.code.trim() || Buffer.byteLength(input.code) > 32 * 1024) throw new Error("REPL code must be non-empty and at most 32KiB.");
    if ((input.evidenceIds?.length ?? 0) > 8 || (input.workspacePaths?.length ?? 0) > 8) throw new Error("At most eight evidence IDs and workspace paths may be staged.");
    const invocationId = createId("repl");
    const started = timestamp();
    const stage = await mkdtemp(join(tmpdir(), "pi-context-flow-repl-"));
    const evidenceDir = join(stage, "evidence"); const workspaceDir = join(stage, "workspace");
    let stagedBytes = 0;
    await mkdir(evidenceDir); await mkdir(workspaceDir);
    try {
      for (const id of input.evidenceIds ?? []) {
        const metadata = await this.metadata(id);
        stagedBytes = await copyLimited(metadata.rawPath, join(evidenceDir, `${id}.txt`), stagedBytes);
      }
      for (const path of input.workspacePaths ?? []) {
        const requested = resolve(this.cwd, path);
        assertReplWorkspacePathAllowed(this.cwd, requested);
        const absolute = await realpath(requested);
        assertReplWorkspacePathAllowed(this.cwd, absolute);
        const info = await stat(absolute);
        if (!info.isFile()) throw new Error("Only regular workspace files may be staged.");
        stagedBytes = await copyLimited(absolute, join(workspaceDir, relative(this.cwd, absolute).replaceAll(sep, "_")), stagedBytes);
      }
      const image = input.language === "python" ? "python:3.12-alpine" : "bash:5.2";
      const command = input.language === "python" ? ["python", "-c", input.code] : ["bash", "-c", input.code];
      const args = ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "1", "--user", "65534:65534", "--env", "HOME=/tmp", "--workdir", "/tmp", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "-v", `${stage}:/inputs:ro`, image, ...command];
      const staged = await stageCommand(runtime, args, { env: SAFE_COMMAND_ENV, timeoutMs: REPL_TIMEOUT_MS, maxBytes: MAX_ARTIFACT_BYTES });
      const raw = await readFile(staged.path, "utf8");
      const output = boundedText(raw, MAX_QUERY_BYTES);
      const outputEvidence = output.truncated || staged.outputLimitReached
        ? await this.captureRaw("context_repl", { invocationId }, raw, staged.outputLimitReached ? "repl output (partial: artifact limit reached)" : "repl output")
        : undefined;
      await rm(staged.directory, { recursive: true, force: true });
      const exitCode = staged.exitCode ?? 1;
      const status = staged.timedOut ? "timed_out" : staged.outputLimitReached ? "output_limited" : "completed";
      await this.run("INSERT INTO repl_invocations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [invocationId, JSON.stringify(input.evidenceIds ?? []), JSON.stringify(input.workspacePaths ?? []), input.language, input.code, JSON.stringify({ wallMs: REPL_TIMEOUT_MS, memory: "256m", pids: 64, inputBytes: MAX_REPL_INPUT_BYTES, responseBytes: MAX_QUERY_BYTES, artifactBytes: MAX_ARTIFACT_BYTES }), started, exitCode, outputEvidence?.evidenceId ?? null, status]);
      const notice = output.truncated || staged.outputLimitReached ? "\n[output truncated; inspect outputEvidence for retained derived output]" : "";
      return { available: true, invocationId, exitCode, output: output.text + notice, outputEvidence: outputEvidence ? this.referenceFor(outputEvidence) : undefined };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  async observe(input: Omit<Observation, "observationId" | "timestamp">): Promise<Observation> {
    const observation: Observation = { ...input, observationId: createId("observation"), timestamp: timestamp() };
    await this.run("INSERT INTO observations VALUES (?, ?, ?, ?)", [observation.observationId, observation.text, observation.category, observation.timestamp]);
    for (const evidenceId of observation.evidenceIds) await this.run("INSERT INTO observation_evidence VALUES (?, ?, ?)", [observation.observationId, evidenceId, null]);
    for (const queryId of observation.queryIds) { const rows = await this.all("SELECT evidence_id FROM evidence_queries WHERE query_id = ?", [queryId]); if (!rows[0]) throw new Error(`Unknown query ID: ${queryId}`); await this.run("INSERT INTO observation_evidence VALUES (?, ?, ?)", [observation.observationId, String(rows[0].evidence_id), queryId]); }
    await appendJsonLine(join(this.root, "observations", "ledger.jsonl"), observation); return observation;
  }

  async promote(input: Omit<ArtifactCandidate, "candidateId" | "timestamp" | "status">): Promise<ArtifactCandidate> {
    const observation = await this.all("SELECT observation_id FROM observations WHERE observation_id = ?", [input.observationId]); if (!observation[0]) throw new Error(`Unknown observation ID: ${input.observationId}`);
    const candidate: ArtifactCandidate = { ...input, candidateId: createId("candidate"), timestamp: timestamp(), status: "candidate" };
    await this.run("INSERT INTO artifact_candidates VALUES (?, ?, ?, ?, ?, ?, ?)", [candidate.candidateId, candidate.observationId, candidate.scope, candidate.target, candidate.rationale, candidate.timestamp, candidate.status]); return candidate;
  }

  private referenceFor(metadata: EvidenceMetadata): EvidenceReference {
    return { evidenceId: metadata.evidenceId, source: metadata.source, sizeBytes: metadata.sizeBytes, shape: metadata.shape, timestamp: metadata.timestamp, tools: metadata.shape === "json" ? ["context_schema", "context_query_records", "context_query_sql", "context_query_jq", "context_read"] : isStructuredShape(metadata.shape) ? ["context_schema", "context_query_records", "context_query_sql"] : metadata.shape === "mixed" ? ["context_search", "context_read", "context_schema", "context_query_records", "context_query_sql"] : ["context_search", "context_read"] };
  }

  private async metadata(evidenceId: string): Promise<EvidenceMetadata> {
    // DuckDB file connections can briefly lag a just-closed writer on some filesystems.
    let row: Row | undefined;
    for (let attempt = 0; attempt < 10 && !row; attempt++) {
      row = (await this.all("SELECT * FROM evidence WHERE evidence_id = ?", [evidenceId]))[0] as Row | undefined;
      if (!row && attempt < 9) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (!row) throw new Error(`Unknown evidence ID: ${evidenceId}`);
    const dependencies = JSON.parse(String(row.dependencies_json ?? "[]")) as string[];
    return { evidenceId, tool: String(row.tool), arguments: JSON.parse(String(row.arguments_json)), timestamp: String(row.timestamp), source: String(row.source), rawPath: String(row.raw_path), sizeBytes: Number(row.size_bytes), shape: String(row.shape) as EvidenceShape, sha256: String(row.sha256), dependencies };
  }
  private async indexText(metadata: EvidenceMetadata, raw: string): Promise<void> {
    const buffer = Buffer.from(raw); const ranges = lineRanges(buffer); let offset = 0; let index = 0;
    while (offset < buffer.length) { let end = Math.min(buffer.length, offset + CHUNK_BYTES); if (end < buffer.length) { const newline = buffer.lastIndexOf(10, end); if (newline >= offset) end = newline + 1; }
      await this.run("INSERT INTO text_chunks VALUES (?, ?, ?, ?, ?, ?, ?)", [metadata.evidenceId, index++, offset, end, lineAt(ranges, offset), lineAt(ranges, Math.max(offset, end - 1)), buffer.subarray(offset, end).toString("utf8")]); offset = end; }
    await this.run("INSERT INTO derived_materializations VALUES (?, ?, ?, ?, ?, ?)", [createId("materialization"), metadata.evidenceId, "lexical_chunks", null, JSON.stringify({ chunkBytes: CHUNK_BYTES }), timestamp()]);
  }
  private async indexMixed(metadata: EvidenceMetadata, raw: string): Promise<void> {
    const parsed = mixedJsonLineRanges(raw);
    for (const item of parsed) await this.run("INSERT INTO mixed_json_lines VALUES (?, ?, ?, ?, ?, ?, ?)", [metadata.evidenceId, item.line, item.byteStart, item.byteEnd, item.line, item.line, item.json]);
    await this.run("INSERT INTO derived_materializations VALUES (?, ?, ?, ?, ?, ?)", [createId("materialization"), metadata.evidenceId, "mixed_fields", null, JSON.stringify({ jsonLines: parsed.length, fields: parsed.slice(0, 20).map(({ line, value }) => ({ line, value })) }), timestamp()]);
  }
  private async captureDerived(parentId: string, queryId: string, kind: string, raw: string, source: string): Promise<EvidenceMetadata> {
    const parent = await this.metadata(parentId); const evidence = await this.captureRaw("context_materialization", { parentId, queryId, kind }, raw, source);
    await this.run("UPDATE evidence SET dependencies_json = ? WHERE evidence_id = ?", [JSON.stringify([parentId]), evidence.evidenceId]);
    await this.run("INSERT INTO derived_materializations VALUES (?, ?, ?, ?, ?, ?)", [createId("materialization"), parentId, kind, null, JSON.stringify({ derivedEvidenceId: evidence.evidenceId, queryId, dependencies: [parentId] }), timestamp()]);
    return { ...evidence, dependencies: [parentId] };
  }
  private queryRecord(evidenceId: string, language: QueryRecord["language"], query: string): QueryRecord { return { queryId: createId("query"), evidenceId, language, query, timestamp: timestamp() }; }
  private async recordQuery(query: QueryRecord, outputEvidenceId?: string): Promise<void> { await this.run("INSERT INTO evidence_queries VALUES (?, ?, ?, ?, ?, ?)", [query.queryId, query.evidenceId, query.language, query.query, query.timestamp, outputEvidenceId ?? null]); }
  private async chunkCount(evidenceId: string): Promise<number> { return Number((await this.all("SELECT count(*) AS count FROM text_chunks WHERE evidence_id = ?", [evidenceId]))[0]?.count ?? 0); }
  private async exec(sql: string): Promise<void> {
    await this.withConnection((connection) => new Promise<void>((ok, fail) => connection.exec(sql, (error) => error ? fail(error) : ok())));
  }
  private async all(sql: string, values: unknown[] = []): Promise<duckdb.TableData> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { return await this.withConnection((connection) => new Promise<duckdb.TableData>((ok, fail) => connection.all(sql, ...values, (error, result) => error ? fail(error) : ok(result)))); }
      catch (error) { lastError = error; if (!/Connection was never established|Connection was already closed/.test(String(error)) || attempt === 4) throw error; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw lastError;
  }
  private async run(sql: string, values: unknown[]): Promise<void> {
    await this.withConnection((connection) => new Promise<void>((ok, fail) => connection.run(sql, ...values, (error) => error ? fail(error) : ok())));
  }
  private async withConnection<T>(operation: (connection: duckdb.Connection) => Promise<T>): Promise<T> {
    if (!this.connection) {
      this.database = new duckdb.Database(this.dbPath);
      this.connection = this.database.connect();
      // The native handle is not always ready in the same tick as connect().
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    return operation(this.connection);
  }
}

type RelationDescription = { relation: string; columns: Array<{ name: string; type: string; nullable: boolean }>; rowCount: number; examples: string[] };

async function describeEvidenceRelation(metadata: EvidenceMetadata, detail: "compact" | "full"): Promise<RelationDescription> {
  const analysis = await analyzeSql(metadata);
  const columns = analysis.rows as Array<{ column_name: string; column_type: string; null: string }>;
  const examples = relationExamples("evidence", columns.map((column) => ({ name: String(column.column_name), type: String(column.column_type) })));
  return { relation: "evidence", columns: columns.map((column) => ({ name: String(column.column_name), type: detail === "full" ? String(column.column_type) : compactDuckDbType(String(column.column_type)), nullable: String(column.null).toUpperCase() !== "NO" })), rowCount: analysis.count ?? 0, examples };
}
function relationExamples(relation: string, columns: Array<{ name: string; type: string }>): string[] {
  const listColumn = columns.find((column) => /\[\]$/.test(column.type));
  if (!listColumn) return [`SELECT * FROM ${relation} LIMIT 20`];
  const identifier = `\"${listColumn.name.replaceAll("\"", "\"\"")}\"`;
  return [
    `SELECT * FROM ${relation} LIMIT 20`,
    `SELECT * FROM ${relation}, unnest(${identifier}) LIMIT 20`,
    `SELECT * FROM ${relation}, unnest(${identifier}) AS item LIMIT 20`,
  ];
}

async function queryEvidenceInMemory(metadata: EvidenceMetadata, sql: string): Promise<duckdb.TableData> {
  return (await analyzeSql(metadata, sql)).rows;
}

function waitForConnection(): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, 5));
}

async function stageCommand(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number }): Promise<StagedCommandResult> {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-flow-output-"));
  const path = join(directory, "output.txt");
  const output = createWriteStream(path, { flags: "w" });
  let bytes = 0; let timedOut = false; let outputLimitReached = false;
  let processError: Error | undefined;
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const append = (chunk: Buffer) => {
    const remaining = options.maxBytes - bytes;
    if (remaining > 0) { const written = chunk.subarray(0, remaining); bytes += written.length; output.write(written); }
    if (chunk.length > remaining && !outputLimitReached) { outputLimitReached = true; child.kill("SIGKILL"); }
  };
  child.stdout.on("data", append); child.stderr.on("data", append);
  child.on("error", (error) => { processError = error; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
  const [exitCode] = await onceProcessClose(child);
  clearTimeout(timer);
  await new Promise<void>((resolveOutput, rejectOutput) => output.end(() => resolveOutput()));
  if (processError && exitCode === null && !timedOut && !outputLimitReached) throw processError;
  return { path, directory, exitCode, timedOut, outputLimitReached };
}

function onceProcessClose(child: ReturnType<typeof spawn>): Promise<[number | null]> {
  return new Promise((resolve) => child.once("close", (code) => resolve([code])));
}

function mixedJsonLineRanges(raw: string): Array<{ line: number; byteStart: number; byteEnd: number; json: string; value: unknown }> {
  const buffer = Buffer.from(raw); const ranges = lineRanges(buffer); const result: Array<{ line: number; byteStart: number; byteEnd: number; json: string; value: unknown }> = [];
  for (const [index, range] of ranges.entries()) {
    const json = buffer.subarray(range.start, range.end).toString("utf8").replace(/\r?\n$/, "");
    try { const value = JSON.parse(json); if (typeof value === "object" && value !== null) result.push({ line: index + 1, byteStart: range.start, byteEnd: range.end, json, value }); } catch {}
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { originalArguments: value }; }
function parseJsonRpcResponse(raw: string): { id?: string | number | null; result?: unknown; error?: unknown } | undefined {
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
    const object = value as Record<string, unknown>;
    if (object.jsonrpc !== "2.0" || (object.result === undefined && object.error === undefined) || (object.result !== undefined && object.error !== undefined)) return undefined;
    return { id: typeof object.id === "string" || typeof object.id === "number" || object.id === null ? object.id : undefined, result: object.result, error: object.error };
  } catch { return undefined; }
}
function isStructuredShape(shape: EvidenceShape): shape is "json" | "csv" | "tsv" | "xml" | "yaml" { return ["json", "csv", "tsv", "xml", "yaml"].includes(shape); }
function classify(raw: string, path?: string): EvidenceShape {
  try { JSON.parse(raw); return "json"; } catch { /* not JSON */ }
  const lowerPath = path?.toLowerCase() ?? "";
  // Extension hints disambiguate files; content detection also classifies tool-result payloads.
  if ((/\.tsv$/u.test(lowerPath) || (!lowerPath && looksDelimited(raw, "\t"))) && looksDelimited(raw, "\t")) return "tsv";
  if ((/\.csv$/u.test(lowerPath) || (!lowerPath && looksDelimited(raw, ","))) && looksDelimited(raw, ",")) return "csv";
  if ((/\.xml$/u.test(lowerPath) || !lowerPath) && /^\s*<\?xml(?:\s|\?>)/u.test(raw)) return "xml";
  if ((/\.(?:yaml|yml)$/u.test(lowerPath) || !lowerPath) && looksYaml(raw)) return "yaml";
  const lines = raw.split(/\r?\n/); const jsonLines = lines.filter((line) => { try { JSON.parse(line); return true; } catch { return false; } }).length;
  return jsonLines > 0 || /^(?:\d{4}-\d\d-\d\d|\[[^\]]+\])|\b(?:ERROR|WARN|INFO|DEBUG)\b/m.test(raw) ? "mixed" : "text";
}
function looksDelimited(raw: string, delimiter: string): boolean { const lines = raw.split(/\r?\n/).filter(Boolean).slice(0, 3); return lines.length >= 2 && lines.every((line) => line.includes(delimiter)); }
function looksYaml(raw: string): boolean { return /^(?:---\s*$|[A-Za-z_][\w-]*:\s*[^\n]*)/m.test(raw); }
function parseYaml(raw: string): unknown { const document = parseDocument(raw, { prettyErrors: false }); if (document.errors.length || document.warnings.length) throw new Error(`YAML parsing failed: ${(document.errors[0] ?? document.warnings[0])?.message ?? "invalid document"}`); const value = document.toJS({ maxAliasCount: 0 }); assertStructuredValueBudget(value); return value; }
function parseXml(raw: string): unknown { const valid = XMLValidator.validate(raw); if (valid !== true) throw new Error(`XML parsing failed: ${valid.err.msg}`); const value = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", processEntities: false, parseTagValue: true, parseAttributeValue: false }).parse(raw); assertStructuredValueBudget(value); return value; }
function assertStructuredValueBudget(value: unknown): void { let nodes = 0; const visit = (current: unknown, depth: number) => { if (++nodes > MAX_STRUCTURED_PARSE_NODES || depth > MAX_STRUCTURED_PARSE_DEPTH) throw new Error("Structured parser exceeded its node or depth limit."); if (Array.isArray(current)) for (const item of current) visit(item, depth + 1); else if (current && typeof current === "object") for (const item of Object.values(current as Record<string, unknown>)) visit(item, depth + 1); }; visit(value, 0); }
function normalizeSql(sql: string): string { return sql.trim().replace(/;\s*$/, ""); }
function compactDuckDbType(type: string): string { return type.replace(/STRUCT\(.+\)(\[\])?$/, (_match, suffix = "") => `STRUCT(...)${suffix}`); }
function compactJsonResult(row: Record<string, unknown>): unknown { const values = Object.values(row); return Object.keys(row).length === 1 ? values[0] : row; }
function safeAlias(value: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Structured query aggregate aliases must be identifiers."); return value; }
function sqlLiteral(value: string | number | boolean): string { if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`; return typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value); }
function quoteIdentifier(value: string): string { return `\"${value.replaceAll("\"", "\"\"")}\"`; }
function validateRecordRequest(input: QueryRecordsInput): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.collectionHint)) throw new Error("collectionHint must be a simple identifier; natural-language matching is unavailable.");
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("limit must be an integer between 1 and 100.");
  if ((input.filters?.length ?? 0) > 10 || (input.select?.length ?? 0) > 16 || (input.orderBy?.length ?? 0) > 4) throw new Error("Record query exceeds its filter, select, or order-by limit.");
  const validPath = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value);
  for (const filter of input.filters ?? []) {
    if (!validPath(filter.field)) throw new Error("Filter fields must be dot-separated identifiers.");
    const hasEquals = filter.equals !== undefined; const hasOneOf = filter.oneOf !== undefined;
    if (hasEquals === hasOneOf) throw new Error("Each filter requires exactly one of equals or oneOf.");
    if (hasOneOf && (!filter.oneOf!.length || filter.oneOf!.length > 50)) throw new Error("Filter oneOf must contain 1-50 scalar values.");
  }
  for (const field of input.select ?? []) if (!validPath(field)) throw new Error("Select fields must be dot-separated identifiers.");
  for (const order of input.orderBy ?? []) {
    if (!validPath(order.field) || !["asc", "desc"].includes(order.direction)) throw new Error("orderBy requires a scalar field and asc or desc direction.");
  }
}
function validateScalarValue(value: ScalarValue, type: Extract<DuckType, { kind: "scalar" }>, field: string): void {
  const normalized = type.type.toUpperCase();
  const valid = typeof value === "string" ? /CHAR|TEXT|STRING|UUID|DATE|TIME|JSON|ENUM/.test(normalized)
    : typeof value === "number" ? /INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL|HUGEINT/.test(normalized)
    : /BOOL/.test(normalized);
  if (!valid) throw new Error(`Filter value for ${JSON.stringify(field)} does not match authoritative type ${type.type}.`);
}
function compactPaths(paths: string[]): string { return paths.slice(0, 8).join(", ") + (paths.length > 8 ? ", ..." : ""); }
function scalarFieldMap(item: Extract<DuckType, { kind: "struct" }>): Map<string, Extract<DuckType, { kind: "scalar" }>> {
  const fields = new Map<string, Extract<DuckType, { kind: "scalar" }>>();
  const visit = (type: DuckType, prefix: string) => {
    if (type.kind === "scalar" && isDuckScalar(type.type)) fields.set(prefix, type);
    else if (type.kind === "struct") for (const [name, child] of type.fields) visit(child, prefix ? `${prefix}.${name}` : name);
  };
  visit(item, ""); return fields;
}
async function recordCollections(metadata: EvidenceMetadata): Promise<RecordCollection[]> {
  const columns = (await analyzeSql(metadata)).rows as Array<{ column_name: string; column_type: string }>;
  const collections: RecordCollection[] = [];
  const visit = (type: DuckType, names: string[]) => {
    if (type.kind === "list" && type.child.kind === "struct") collections.push({ path: names, item: type.child });
    // A list is a collection boundary, not a dotted relation path; only descend through STRUCT fields.
    if (type.kind === "struct") for (const [name, child] of type.fields) visit(child, [...names, name]);
  };
  for (const column of columns) visit(parseDuckType(String(column.column_type)), [String(column.column_name)]);
  return collections;
}
function isDuckScalar(type: string): boolean {
  return /^(?:BOOL(?:EAN)?|TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC|VARCHAR|CHAR|STRING|UUID|DATE|TIME|TIMESTAMP|INTERVAL|BLOB|BIT|BIGNUM|ENUM)(?:\b|\s|\()/i.test(type);
}
function parseDuckType(source: string): DuckType {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? "")) index++; };
  const word = () => { whitespace(); const start = index; while (/[A-Za-z0-9_]/.test(source[index] ?? "")) index++; return source.slice(start, index); };
  const fieldName = () => {
    whitespace();
    if (source[index] !== "\"") return word();
    index++; let value = "";
    while (source[index]) { if (source[index] === "\"" && source[index + 1] === "\"") { value += "\""; index += 2; } else if (source[index] === "\"") { index++; return value; } else value += source[index++]; }
    throw new Error("Unable to parse authoritative DuckDB STRUCT field.");
  };
  const parse = (): DuckType => {
    const start = index; const name = word(); whitespace();
    let type: DuckType;
    if (name.toUpperCase() === "STRUCT" && source[index] === "(") {
      index++; const fields = new Map<string, DuckType>();
      while (true) { whitespace(); if (source[index] === ")") { index++; break; } const field = fieldName(); const child = parse(); fields.set(field, child); whitespace(); if (source[index] === ",") index++; else if (source[index] === ")") { index++; break; } else throw new Error("Unable to parse authoritative DuckDB STRUCT type."); }
      type = { kind: "struct", fields };
    } else {
      // Scalar type names can include spaces and parameters (for example DECIMAL(18, 3)).
      let depth = 0; let quote: "'" | "\"" | undefined;
      while (source[index]) {
        const char = source[index];
        if (quote) { if (char === quote) quote = undefined; index++; continue; }
        if (char === "'" || char === "\"") { quote = char; index++; continue; }
        if (char === "(") depth++;
        else if (char === ")") { if (!depth) break; depth--; }
        else if (!depth && (char === "," || source.slice(index, index + 2) === "[]")) break;
        index++;
      }
      type = { kind: "scalar", type: source.slice(start, index).trim() };
    }
    whitespace(); while (source.slice(index, index + 2) === "[]") { type = { kind: "list", child: type }; index += 2; whitespace(); }
    return type;
  };
  const result = parse(); whitespace(); if (index !== source.length) throw new Error("Unable to parse authoritative DuckDB type."); return result;
}
function validateSql(sql: string): void {
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) throw new Error(`SQL must be at most ${MAX_SQL_BYTES} bytes.`);
  const normalized = sql.trim(); const code = sqlCode(sql);
  if (!/^(select|with)\b/i.test(normalized) || /;/.test(code)) throw new Error("SQL must be one SELECT or WITH query without semicolons.");
  if (!/\bevidence\b/i.test(code)) throw new Error("SQL must query the evidence relation.");
  if (/\b(insert|update|delete|create|drop|alter|copy|attach|detach|install|load|pragma(?:_[a-z_]*)?|call|export|import|vacuum|transaction|begin|commit|rollback|read_[a-z_]*|parquet_scan|csv_scan|glob|httpfs|duckdb_|information_schema|pg_[a-z_]*|sqlite_)\b/i.test(code)) throw new Error("SQL contains a prohibited write, catalog, extension, or external-read operation.");
}

// Preserve offsets while excluding comments and string literals from policy checks.
function sqlCode(sql: string): string {
  let result = ""; let quote: "'" | '"' | undefined; let lineComment = false; let blockComment = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]; const next = sql[index + 1];
    if (lineComment) { if (char === "\n") { lineComment = false; result += char; } else result += " "; continue; }
    if (blockComment) { if (char === "*" && next === "/") { result += "  "; index++; blockComment = false; } else result += char === "\n" ? "\n" : " "; continue; }
    if (quote) { if (char === quote && next === quote) { result += "  "; index++; } else { result += " "; if (char === quote) quote = undefined; } continue; }
    if (char === "-" && next === "-") { result += "  "; index++; lineComment = true; continue; }
    if (char === "/" && next === "*") { result += "  "; index++; blockComment = true; continue; }
    if (char === "'" || char === '"') { result += " "; quote = char; continue; }
    result += char;
  }
  return result;
}
function bounded<T>(value: T, maxBytes: number): BoundedResult<T> { const serialized = stringify(value); const bytes = Buffer.byteLength(serialized); if (bytes <= maxBytes) return { value, truncated: false, bytes }; const clipped = Buffer.from(serialized).subarray(0, maxBytes).toString("utf8"); return { value: { truncated: true, preview: clipped } as T, truncated: true, bytes }; }
function stringify(value: unknown): string { return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? (item <= BigInt(Number.MAX_SAFE_INTEGER) && item >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(item) : item.toString()) : item); }
function jsonSafe(value: unknown): unknown { return JSON.parse(stringify(value)); }
function boundedText(text: string, maxBytes: number): { text: string; truncated: boolean } { const bytes = Buffer.from(text); return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: bytes.length > maxBytes }; }
function jsonPath(value: unknown, path: string): unknown { if (path === "$") return value; if (!/^\$(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/u.test(path)) throw new Error("Only simple $.key and [index] JSON paths are supported."); let current: unknown = value; for (const match of path.matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) { current = Array.isArray(current) ? current[Number(match[2])] : current && typeof current === "object" ? (current as Record<string, unknown>)[match[1]] : undefined; } return current; }
function lineRanges(buffer: Buffer): Array<{ start: number; end: number }> { const ranges: Array<{ start: number; end: number }> = []; let start = 0; for (let i = 0; i < buffer.length; i++) if (buffer[i] === 10) { ranges.push({ start, end: i + 1 }); start = i + 1; } if (start < buffer.length || !ranges.length) ranges.push({ start, end: buffer.length }); return ranges; }
function lineAt(ranges: Array<{ start: number; end: number }>, offset: number): number { const index = ranges.findIndex((range) => offset >= range.start && offset < range.end); return index === -1 ? ranges.length : index + 1; }
function tokenize(value: string): string[] { return [...new Set(value.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])]; }
function normalizeEvidenceId(value: string): string { return value.startsWith("evidence://") ? value.slice("evidence://".length) : value; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function assertCaptureWorkspacePathAllowed(cwd: string, absolutePath: string): void {
  const worktree = resolve(cwd);
  const candidate = resolve(absolutePath);
  if (candidate !== worktree && !candidate.startsWith(worktree + sep)) throw new Error("Workspace paths must remain beneath the current worktree, including after symlink resolution.");
  const workspaceRelative = relative(worktree, candidate);
  if (workspaceRelative === ".pi/context" || workspaceRelative.startsWith(`.pi${sep}context${sep}`)) throw new Error("Workspace paths beneath .pi/context cannot be captured or staged.");
}

export function assertReplWorkspacePathAllowed(cwd: string, absolutePath: string): void {
  try { assertCaptureWorkspacePathAllowed(cwd, absolutePath); } catch (error) {
    if (error instanceof Error && error.message.includes(".pi/context")) throw new Error("Workspace paths beneath .pi/context cannot be staged in the REPL.");
    throw error;
  }
}
function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) { const candidate = join(directory, name); if (existsSync(candidate)) return candidate; }
  return undefined;
}

async function containerRuntime(): Promise<"docker" | "podman" | undefined> { for (const runtime of ["docker", "podman"] as const) try { await execFile(runtime, ["version", "--format", "{{.Server.Version}}"], { timeout: 2_000, env: {}, windowsHide: true }); return runtime; } catch {} return undefined; }
async function copyLimited(source: string, target: string, usedBytes: number): Promise<number> { const info = await stat(source); if (info.size > MAX_REPL_INPUT_BYTES || usedBytes + info.size > MAX_REPL_INPUT_BYTES) throw new Error(`Selected inputs exceed the ${MAX_REPL_INPUT_BYTES} byte REPL input limit.`); await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); return usedBytes + info.size; }
async function closeDatabase(connection: duckdb.Connection, db: duckdb.Database): Promise<void> {
  // Timed queries may already have closed their isolated connection.
  await new Promise<void>((ok) => connection.close(() => ok()));
  await new Promise<void>((ok) => db.close(() => ok()));
  // The native binding releases file locks asynchronously after close callbacks fire.
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
}
async function appendJsonLine(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); let existing = ""; try { existing = await readFile(path, "utf8"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await writeFile(path, existing + JSON.stringify(value) + "\n"); }
function describeJson(value: unknown, path = "$", result: unknown[] = [], depth = 0, maxDepth = 6, maxNodes = 200): unknown[] {
  if (result.length >= maxNodes) { if (!result.some((item) => (item as Row).truncated)) result.push({ truncated: true, reason: "node budget" }); return result; }
  if (depth > maxDepth) { result.push({ path, truncated: true, reason: "depth budget" }); return result; }
  if (Array.isArray(value)) { result.push({ path, type: "array", sampleLength: value.length }); if (value.length) describeJson(value[0], `${path}[0]`, result, depth + 1, maxDepth, maxNodes); }
  else if (value !== null && typeof value === "object") { result.push({ path, type: "object", keys: Object.keys(value as Record<string, unknown>) }); for (const [key, child] of Object.entries(value as Record<string, unknown>)) { if (result.length >= maxNodes) break; describeJson(child, `${path}.${key}`, result, depth + 1, maxDepth, maxNodes); } }
  else result.push({ path, type: value === null ? "null" : typeof value }); return result;
}
