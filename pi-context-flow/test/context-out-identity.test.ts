import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeRemote, resolveContextOutIdentity } from "../src/context-out/identity.js";

function git(path: string, ...args: string[]) { return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "context-out-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo); git(repo, "init");
  const options = { home: join(root, "home") };
  return { root, repo, options };
}

test("canonical remote fixtures preserve endpoint boundaries and remove credentials", () => {
  for (const value of ["git@github.com:Owner/Repo.git", "https://token:secret@github.com/Owner/Repo", "ssh://git@github.com/Owner/Repo.git"]) {
    assert.equal(canonicalizeRemote(value), "https://github.com/Owner/Repo");
  }
  assert.notEqual(canonicalizeRemote("ssh://git@github.com:2222/Owner/Repo.git"), canonicalizeRemote("https://github.com/Owner/Repo"));
  assert.equal(canonicalizeRemote("https://user:secret@example.com/A.git"), "https://example.com/A.git");
  for (const value of ["", "/tmp/repo", "file:///tmp/repo", "bad url", "https://github.com/a/b?token=secret"]) assert.equal(canonicalizeRemote(value), null);
});

test("same remote shares repository identity, not clone/worktree identity", async (t) => {
  const { root, repo, options } = await fixture(t);
  git(repo, "remote", "add", "origin", "git@github.com:owner/repo.git");
  const first = await resolveContextOutIdentity(repo, options);
  const other = join(root, "other"); await mkdir(other); git(other, "init");
  git(other, "remote", "add", "origin", "https://user:secret@github.com/owner/repo");
  const second = await resolveContextOutIdentity(other, options);
  assert.equal(first.repositoryId, second.repositoryId);
  assert.notEqual(first.cloneId, second.cloneId); assert.notEqual(first.worktreeId, second.worktreeId);
  assert.equal((await stat(first.storageRoot)).mode & 0o777, 0o700);
  assert.ok(!(await readFile(join(first.repositoryRoot, "repository.json"), "utf8")).includes("secret"));
  git(other, "remote", "set-url", "origin", "https://github.com/fork/repo");
  await assert.rejects(resolveContextOutIdentity(other, options), /reassociation/);
  await rm(other, { recursive: true }); await mkdir(other); git(other, "init");
  git(other, "remote", "add", "origin", "https://github.com/fork/repo");
  assert.notEqual((await resolveContextOutIdentity(other, options)).repositoryId, first.repositoryId);
});

test("linked worktrees, subdirectories, moves and deletion preserve appropriate identities", async (t) => {
  const { root, repo, options } = await fixture(t);
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
  const linked = join(root, "linked"); git(repo, "worktree", "add", "--detach", linked);
  const first = await resolveContextOutIdentity(repo, options);
  const second = await resolveContextOutIdentity(linked, options);
  assert.equal(first.cloneId, second.cloneId); assert.equal(first.repositoryId, second.repositoryId);
  assert.notEqual(first.worktreeId, second.worktreeId);
  await mkdir(join(linked, "sub")); assert.equal((await resolveContextOutIdentity(join(linked, "sub"), options)).worktreeId, second.worktreeId);
  git(repo, "worktree", "remove", "--force", linked);
  assert.ok(await stat(second.eventsRoot));
  const moved = join(root, "moved"); await rename(repo, moved);
  assert.equal((await resolveContextOutIdentity(moved, options)).cloneId, first.cloneId);
  await rm(moved, { recursive: true }); assert.ok(await stat(first.repositoryRoot));
});

test("concurrent initialization converges and no-remote reassociation is explicit", async (t) => {
  const { repo, options } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => resolveContextOutIdentity(repo, options)));
  assert.equal(new Set(results.map((r) => r.repositoryId)).size, 1);
  assert.equal(new Set(results.map((r) => r.worktreeId)).size, 1);
  assert.match(results[0].repositoryId, /^local_/);
  git(repo, "remote", "add", "origin", "https://github.com/owner/repo");
  await assert.rejects(resolveContextOutIdentity(repo, options), /reassociation/);
});

test("non-Git and invalid storage roots fail explicitly", async (t) => {
  const { root, repo, options } = await fixture(t);
  await assert.rejects(resolveContextOutIdentity(root, options), /requires a resolvable Git worktree/);
  await mkdir(options.home, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(options.home, ".config"), "not a directory");
  await assert.rejects(resolveContextOutIdentity(repo, options), /identity\/storage/);
});
