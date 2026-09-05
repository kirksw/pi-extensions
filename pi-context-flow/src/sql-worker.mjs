// Plain ESM deliberately needs no TypeScript loader in the subprocess.
import duckdb from 'duckdb';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseDocument } from 'yaml';
const MAX_STRUCTURED_PARSE_NODES = 100_000;
const MAX_STRUCTURED_PARSE_DEPTH = 100;
async function materializeEvidenceRelation(connection, metadata, directory) {
    await execConnection(connection, "SET threads=1; SET memory_limit='256MB'; SET max_expression_depth=1000; SET preserve_insertion_order=false;");
    if (metadata.shape === "mixed") {
        await execConnection(connection, "CREATE TABLE evidence (line BIGINT, byte_start BIGINT, byte_end BIGINT, line_start INTEGER, line_end INTEGER, json VARCHAR);");
        const raw = await readFile(metadata.rawPath, "utf8");
        for (const item of mixedJsonLineRanges(raw))
            await runConnection(connection, "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?)", [item.line, item.byteStart, item.byteEnd, item.line, item.line, item.json]);
        return;
    }
    if (metadata.shape === "json") {
        await execConnection(connection, `CREATE TABLE evidence AS SELECT * FROM read_json_auto('${metadata.rawPath.replaceAll("'", "''")}');`);
        return;
    }
    if (metadata.shape === "csv" || metadata.shape === "tsv") {
        const delimiter = metadata.shape === "tsv" ? "\t" : ",";
        await execConnection(connection, `CREATE TABLE evidence AS SELECT * FROM read_csv_auto('${metadata.rawPath.replaceAll("'", "''")}', delim='${delimiter}');`);
        return;
    }
    const raw = await readFile(metadata.rawPath, "utf8");
    const value = metadata.shape === "xml" ? parseXml(raw) : parseYaml(raw);
    const path = join(directory, "materialized.json");
    await writeFile(path, JSON.stringify(value), "utf8");
    await execConnection(connection, `CREATE TABLE evidence AS SELECT * FROM read_json_auto('${path.replaceAll("'", "''")}');`);
    return;
}
async function execConnection(connection, sql) { await new Promise((ok, fail) => connection.exec(sql, (error) => error ? fail(error) : ok())); }
async function allConnection(connection, sql) { return await new Promise((ok, fail) => connection.all(sql, (error, result) => error ? fail(error) : ok(result))); }
async function runConnection(connection, sql, values) { await new Promise((ok, fail) => connection.run(sql, ...values, (error) => error ? fail(error) : ok())); }
function mixedJsonLineRanges(raw) {
    const buffer = Buffer.from(raw);
    const ranges = lineRanges(buffer);
    const result = [];
    for (const [index, range] of ranges.entries()) {
        const json = buffer.subarray(range.start, range.end).toString("utf8").replace(/\r?\n$/, "");
        try {
            const value = JSON.parse(json);
            if (typeof value === "object" && value !== null)
                result.push({ line: index + 1, byteStart: range.start, byteEnd: range.end, json, value });
        }
        catch { }
    }
    return result;
}
// Keep ingestion semantics aligned with store.ts capture classification/validation.
function parseYaml(raw) {
    const document = parseDocument(raw, { prettyErrors: false });
    if (document.errors.length || document.warnings.length) throw new Error(`YAML parsing failed: ${(document.errors[0] ?? document.warnings[0])?.message ?? "invalid document"}`);
    const value = document.toJS({ maxAliasCount: 0 });
    assertStructuredValueBudget(value);
    return value;
}
function parseXml(raw) {
    const valid = XMLValidator.validate(raw);
    if (valid !== true) throw new Error(`XML parsing failed: ${valid.err.msg}`);
    const value = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", processEntities: false, parseTagValue: true, parseAttributeValue: false }).parse(raw);
    assertStructuredValueBudget(value);
    return value;
}
function assertStructuredValueBudget(value) {
    let nodes = 0;
    const visit = (current, depth) => {
        if (++nodes > MAX_STRUCTURED_PARSE_NODES || depth > MAX_STRUCTURED_PARSE_DEPTH) throw new Error("Structured parser exceeded its node or depth limit.");
        if (Array.isArray(current)) for (const item of current) visit(item, depth + 1);
        else if (current && typeof current === "object") for (const item of Object.values(current)) visit(item, depth + 1);
    };
    visit(value, 0);
}
function lineRanges(buffer) {
    const ranges = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 10) { ranges.push({ start, end: i + 1 }); start = i + 1; }
    }
    if (start < buffer.length || !ranges.length) ranges.push({ start, end: buffer.length });
    return ranges;
}

// Native allocations are governed by DuckDB, not V8's heap limit. No disk spill.
// The parent kills and reaps this process even if native execution or JS parsing stalls.
process.once('message', async ({ metadata, sql, directory, maxRows, maxBytes }) => {
    try {
        const db = new duckdb.Database(':memory:', { memory_limit: '256MB', threads: '1', preserve_insertion_order: 'false' });
        const connection = db.connect();
        await execConnection(connection, "SET temp_directory='';");
        await materializeEvidenceRelation(connection, metadata, directory);
        // Trusted ingestion is finished. User SQL cannot read files, load extensions or write externally.
        await execConnection(connection, "SET enable_external_access=false; SET lock_configuration=true;");
        const source = sql === undefined ? 'SELECT * FROM (DESCRIBE evidence)' : `SELECT * FROM (${sql}\n) AS context_bounded LIMIT ${maxRows}`;
        await execConnection(connection, `CREATE TEMP TABLE context_result AS ${source}`);
        // Check the complete retained result in DuckDB before the binding converts any values.
        // Fail rather than pretend an oversized scalar or nested value is complete.
        const sizes = await allConnection(connection, 'SELECT coalesce(sum(octet_length(encode(to_json(r)))), 0) AS bytes FROM context_result r');
        if (Number(sizes[0].bytes) > maxBytes) throw new Error(`SQL retained result exceeds its ${maxBytes} byte materialization limit; project smaller values.`);
        const rows = await allConnection(connection, 'SELECT * FROM context_result');
        const count = sql === undefined ? await allConnection(connection, 'SELECT count(*) AS count FROM evidence') : undefined;
        process.send({ rows, count: count ? Number(count[0].count) : undefined });
    } catch (error) {
        process.send({ error: String(error?.message ?? error).slice(0, 4096) });
    }
});
