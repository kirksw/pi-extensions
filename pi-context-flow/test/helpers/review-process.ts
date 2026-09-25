import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// Every worker has an outer deadline, bounded diagnostics, and is reaped before fixture deletion.
export function reviewProcess(cwd: string, env: NodeJS.ProcessEnv = { PATH: process.env.PATH }, lifetime = 45000) {
  const child = fork(fileURLToPath(new URL("./review-worker.ts", import.meta.url)), [cwd], {
    execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stdout?.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  child.stderr?.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const deadline = setTimeout(() => child.kill("SIGKILL"), lifetime);
  return {
    async call(message: object, timeout = 15000): Promise<any> {
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exit); };
        const receive = (reply: any) => { cleanup(); reply.error ? reject(new Error(reply.error)) : resolve(reply.value); };
        const exit = (code: number | null, signal: string | null) => { cleanup(); reject(new Error(`Worker exited ${code}/${signal}: ${diagnostics}`)); };
        const timer = setTimeout(() => { cleanup(); child.kill("SIGKILL"); reject(new Error(`Worker request deadline: ${JSON.stringify(message)} ${diagnostics}`)); }, timeout);
        child.once("message", receive); child.once("exit", exit);
        child.send(message, (error) => { if (error) { cleanup(); reject(error); } });
      });
    },
    cancel() { child.send({ op: "cancel" }); },
    async stop() { clearTimeout(deadline); child.kill("SIGKILL"); await closed; },
  };
}
