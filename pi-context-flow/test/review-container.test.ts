import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { reviewProcess } from "./helpers/review-process.js";

const enabled = process.env.CONTEXT_FLOW_CONTAINER_ACCEPTANCE === "1";
const image = "python:3.12-alpine";
for (const scenario of ["security", "timeout", "overflow"] as const) {
  test(`real container acceptance: ${scenario}`, { skip: !enabled && "opt-in: CONTEXT_FLOW_CONTAINER_ACCEPTANCE=1", timeout: 90000 }, async (t) => {
    const cli = ["docker", "podman"].flatMap((name) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, name))).find(existsSync);
    if (!cli) return t.skip("missing Docker/Podman CLI");
    const command = (...args: string[]) => execFileSync(cli, args, { timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try { command("version", "--format", "{{.Server.Version}}"); } catch { return t.skip("CLI present, daemon unavailable"); }
    try { command("image", "inspect", image); } catch { return t.skip(`daemon available, required cached image missing: ${image}; no pulls performed`); }
    const root = await mkdtemp(join(tmpdir(), "context-container-review-"));
    const name = `context-review-${randomUUID()}`, label = `context-flow-review=${name}`;
    const bin = join(root, "bin"); await mkdir(bin);
    // Transparent test-only wrapper adds ownership, never security flags or cleanup.
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const wrapper = `#!/bin/sh\nif [ "$1" = run ]; then\n shift\n exec ${quote(cli)} run --name ${quote(name)} --label ${quote(label)} "$@"\nfi\nexec ${quote(cli)} "$@"\n`;
    for (const runtime of ["docker", "podman"]) await writeFile(join(bin, runtime), wrapper, { mode: 0o755 });
    await writeFile(join(root, "selected.txt"), "synthetic-selected-input");
    const worker = reviewProcess(root, { PATH: bin, REVIEW_FAKE_SECRET: "synthetic-sentinel" }, 75000);
    const owned = () => command("ps", "-aq", "--filter", `label=${label}`).trim().split(/\s+/).filter(Boolean);
    try {
      await worker.call({ op: "init" });
      const { evidenceId } = await worker.call({ op: "capture" });
      const code = scenario === "security" ? `import os, socket, time
assert open('/inputs/workspace/selected.txt').read() == 'synthetic-selected-input'
assert 'values' in open('/inputs/evidence/${evidenceId}.txt').read()
assert 'REVIEW_FAKE_SECRET' not in os.environ
for path in ['/inputs/workspace/selected.txt', '/forbidden-write']:
 try:
  open(path, 'w').write('bad')
  raise AssertionError('write succeeded: ' + path)
 except OSError: pass
s = socket.socket(); s.settimeout(1)
assert s.connect_ex(('198.51.100.1', 80)) != 0
print('security-ok', flush=True)
time.sleep(2)` : scenario === "timeout" ? "import time; time.sleep(120)" : "import sys,time\ntime.sleep(2)\nwhile True: sys.stdout.write('x'*65536); sys.stdout.flush()";
      const started = Date.now();
      const pending = worker.call({ op: "repl", input: { language: "python", code, evidenceIds: [evidenceId], workspacePaths: ["selected.txt"] } }, 40000).then((value) => ({ value }), (error: unknown) => ({ error }));
      // Observe the daemon while the invocation is live; mocks cannot establish isolation.
      let inspect: any;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { inspect = JSON.parse(command("inspect", name))[0]; break; } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      const settled = await pending;
      if ("error" in settled) throw settled.error;
      const result = settled.value;
      assert.equal(result.available, true, result.reason);
      assert.ok(inspect, "test-owned container must be observed on daemon");
      assert.equal(inspect.HostConfig.NetworkMode, "none");
      assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
      assert.equal(inspect.Config.User, "65534:65534");
      assert.equal(inspect.HostConfig.Memory, 256 * 1024 * 1024);
      assert.equal(inspect.HostConfig.PidsLimit, 64);
      assert.equal(inspect.HostConfig.NanoCpus, 1e9);
      assert.ok(inspect.HostConfig.CapDrop.includes("ALL"));
      assert.ok(inspect.HostConfig.SecurityOpt.some((s: string) => s.includes("no-new-privileges")));
      assert.equal(inspect.Mounts.find((m: any) => m.Destination === "/inputs").RW, false);
      assert.ok(!inspect.Config.Env.some((s: string) => s.startsWith("REVIEW_FAKE_SECRET=")));
      if (scenario === "security") { assert.equal(result.exitCode, 0); assert.match(result.output, /security-ok/); }
      if (scenario === "timeout") {
        assert.notEqual(result.exitCode, 0, "timeout cannot report success");
        assert.ok(Date.now() - started < 20000, "ten-second REPL deadline must be bounded");
      }
      if (scenario === "overflow") {
        assert.ok(result.outputEvidence, "overflow retained as bounded evidence");
        assert.ok(Buffer.byteLength(result.output) < 66000, "inline output stays bounded");
      }
      // Check BEFORE finally cleanup: cleanup by the harness is not production success.
      for (let attempt = 0; attempt < 20 && owned().length; attempt++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(owned(), [], `container survives ${scenario}`);
    } finally {
      await worker.stop();
      try { for (const id of owned()) command("rm", "-f", id); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });
}
