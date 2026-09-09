import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withStoreLock } from "../src/store-lock.js";

test("store lock serializes callers, records ownership, and releases after errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "store-lock-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "lock"); let active = 0;
  await Promise.all(Array.from({ length: 4 }, () => withStoreLock(path, async () => {
    assert.equal(active++, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
    await new Promise((resolve) => setTimeout(resolve, 10)); active--;
  })));
  await assert.rejects(withStoreLock(path, async () => { throw new Error("operation failed"); }), /operation failed/);
  await assert.rejects(access(path), { code: "ENOENT" });
  await withStoreLock(path, async () => {});
});

test("store contention times out without stealing an existing lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "store-busy-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "lock"); await writeFile(path, "owner sentinel"); const started = performance.now();
  await assert.rejects(withStoreLock(path, async () => assert.fail("must not enter")), /Context Flow store busy.*recorded owner/);
  assert.ok(performance.now() - started < 3000);
  assert.equal(await readFile(path, "utf8"), "owner sentinel");
});

test("queued timeout cannot let later callers overtake the active owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "store-queue-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "lock"); let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const owner = withStoreLock(path, async () => { entered(); await hold; });
  try {
    await ready;
    await assert.rejects(withStoreLock(path, async () => assert.fail("queued timeout entered")), /store busy/);
    let laterEntered = false;
    const later = withStoreLock(path, async () => { laterEntered = true; });
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(laterEntered, false);
    release(); await owner; await later;
  } finally { release(); await owner; }
});

test("database worker releases native locks after errors and successful writes", async (t) => {
  const { storeDatabase } = await import("../src/store-database.js");
  const root = await mkdtemp(join(tmpdir(), "store-worker-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.duckdb");
  await storeDatabase(path, "exec", "CREATE TABLE entries (value INTEGER)");
  await assert.rejects(storeDatabase(path, "exec", "INVALID SQL"));
  await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
  await Promise.all([1, 2].map((value) => storeDatabase(path, "run", "INSERT INTO entries VALUES (?)", [value])));
  assert.deepEqual(await storeDatabase(path, "all", "SELECT value FROM entries ORDER BY value"), [{ value: 1 }, { value: 2 }]);
  await writeFile(path, "invalid database");
  await assert.rejects(storeDatabase(path, "all", "SELECT 1"));
  await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
});
