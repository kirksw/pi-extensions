import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";

const exec = promisify(execFile);
const VERSION = 1;
type Marker = { version: number; id: string; repositoryId: string };
export type ContextOutIdentity = {
  repositoryId: string; canonicalRemote: string | null; cloneId: string; worktreeId: string;
  worktreeRoot: string; commonGitDirectory: string; gitDirectory: string;
  storageRoot: string; repositoryRoot: string; eventsRoot: string;
};

/** Normalize only known hosting conventions; unknown endpoints retain transport distinctions. */
export function canonicalizeRemote(raw: string): string | null {
  if (!raw || raw.trim() !== raw || /[\x00-\x20\x7f]/.test(raw)) return null;
  const scp = /^([^/@:]+@)?([^/:]+):(.+)$/.exec(raw);
  const candidate = !raw.includes("://") && scp
    ? `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}` : raw;
  let url: URL;
  try { url = new URL(candidate); } catch { return null; }
  if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol) || !url.hostname || url.search || url.hash) return null;
  url.username = ""; url.password = "";
  const path = url.pathname.replace(/\/$/, "");
  if (!path || path === "/" || /%2f|%5c/i.test(path)) return null;
  const known = ["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname);
  if (known && !url.port && ["ssh:", "https:"].includes(url.protocol)) {
    const normalized = path.replace(/\.git$/, "");
    if (normalized.split("/").length < 3) return null;
    return `https://${url.hostname}${normalized}`;
  }
  url.pathname = path;
  return url.toString();
}

function remoteId(remote: string): string {
  return `repo_${createHash("sha256").update(`v${VERSION}\n${remote}`).digest("hex")}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  // Inherited Git overrides must not redirect identity resolution to a different checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const { stdout } = await exec("git", ["-C", cwd, ...args], { env, timeout: 5_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Context Out storage must be a real directory");
  await chmod(path, 0o700);
}

/** Publish a fully written identity without exposing partial JSON to concurrent readers. */
async function establish<T>(path: string, value: T): Promise<T> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary); }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid Context Out identity file");
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function validateMarker(marker: Marker): void {
  if (marker.version !== VERSION || typeof marker.id !== "string" || !/^[0-9a-f-]{36}$/.test(marker.id)
    || typeof marker.repositoryId !== "string" || !/^(repo_[0-9a-f]{64}|local_[0-9a-f-]{36})$/.test(marker.repositoryId)) {
    throw new Error("Invalid Context Out identity marker");
  }
}

export async function resolveContextOutIdentity(cwd: string, options: { home?: string } = {}): Promise<ContextOutIdentity> {
  let worktreeRoot: string, commonGitDirectory: string, gitDirectory: string;
  try {
    worktreeRoot = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
    const common = await git(worktreeRoot, ["rev-parse", "--git-common-dir"]);
    const own = await git(worktreeRoot, ["rev-parse", "--git-dir"]);
    commonGitDirectory = await realpath(isAbsolute(common) ? common : resolve(worktreeRoot, common));
    gitDirectory = await realpath(isAbsolute(own) ? own : resolve(worktreeRoot, own));
  } catch { throw new Error("Context Out requires a resolvable Git worktree"); }

  let remotes: string;
  try { remotes = await git(worktreeRoot, ["config", "--get-all", "remote.origin.url"]); }
  catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw new Error("Cannot inspect Context Out origin configuration");
    remotes = "";
  }
  const urls = remotes ? remotes.split("\n") : [];
  if (urls.length > 1) throw new Error("Multiple origin URLs require explicit repository selection");
  const canonicalRemote = canonicalizeRemote(urls[0] ?? "");
  const expectedId = canonicalRemote ? remoteId(canonicalRemote) : null;
  const storageRoot = join(options.home ?? homedir(), ".config", "pi-context-flow");
  try {
    await privateDirectory(storageRoot);
    await privateDirectory(join(storageRoot, "repositories"));
    const markerDirectory = join(commonGitDirectory, "pi-context-flow");
    await privateDirectory(markerDirectory);
    const clone = await establish<Marker>(join(markerDirectory, "clone.json"), {
      version: VERSION, id: randomUUID(), repositoryId: expectedId ?? `local_${randomUUID()}`,
    });
    validateMarker(clone);
    if (expectedId ? clone.repositoryId !== expectedId : !clone.repositoryId.startsWith("local_")) {
      throw new Error("Repository remote changed; explicit identity reassociation is required");
    }
    const ownDirectory = join(gitDirectory, "pi-context-flow");
    await privateDirectory(ownDirectory);
    const worktree = await establish<Marker>(join(ownDirectory, "worktree.json"), {
      version: VERSION, id: randomUUID(), repositoryId: clone.repositoryId,
    });
    validateMarker(worktree);
    if (worktree.repositoryId !== clone.repositoryId) throw new Error("Worktree identity requires explicit reassociation");
    const repositoryRoot = join(storageRoot, "repositories", clone.repositoryId);
    await privateDirectory(repositoryRoot);
    const metadata = await establish(join(repositoryRoot, "repository.json"), {
      version: VERSION, repositoryId: clone.repositoryId, canonicalRemote,
    });
    if (metadata.version !== VERSION || metadata.repositoryId !== clone.repositoryId || metadata.canonicalRemote !== canonicalRemote) {
      throw new Error("Repository metadata conflicts with resolved identity");
    }
    const eventsRoot = join(repositoryRoot, "events");
    await privateDirectory(eventsRoot);
    return { repositoryId: clone.repositoryId, canonicalRemote, cloneId: clone.id, worktreeId: worktree.id,
      worktreeRoot, commonGitDirectory, gitDirectory, storageRoot, repositoryRoot, eventsRoot };
  } catch (error) {
    if (error instanceof Error && /reassociation|metadata conflicts|identity marker/.test(error.message)) throw error;
    throw new Error("Cannot initialize Context Out identity/storage; check permissions and metadata");
  }
}
