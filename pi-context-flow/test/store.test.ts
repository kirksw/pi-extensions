import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextStore } from "../src/store.js";

test("captures, queries, observes, and promotes with provenance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-flow-"));
  const store = new ContextStore(cwd);
  await store.initialize();

  const evidence = await store.capture("linear.searchIssues", { team: "core" }, [
    { id: "ENG-1", title: "Open", status: "In Progress", priority: 1 },
    { id: "ENG-2", title: "Closed", status: "Done", priority: 3 },
  ]);
  const schema = await store.inspectSchema(evidence.evidenceId) as { relation: string; columns: Array<{ name: string; type: string }>; rowCount: number };
  assert.equal(schema.relation, "evidence");
  assert.deepEqual(schema.columns.map((column) => column.name), ["id", "title", "status", "priority"]);
  assert.equal(schema.rowCount, 2);

  const query = await store.querySql(evidence.evidenceId, "SELECT id, title FROM evidence WHERE status != 'Done'");
  assert.deepEqual(query.rows, [{ id: "ENG-1", title: "Open" }]);

  const observation = await store.observe({
    text: "One issue remains active.",
    category: "relationship",
    evidenceIds: [],
    queryIds: [query.query.queryId],
  });
  const candidate = await store.promote({
    observationId: observation.observationId,
    scope: "repo",
    target: "docs/open-work.md",
    rationale: "Track the active issue as durable project knowledge.",
  });
  assert.equal(candidate.status, "candidate");
});
