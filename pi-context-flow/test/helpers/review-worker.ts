import { ContextStore } from "../../src/store.js";
import register from "../../src/index.js";
const cwd = process.argv[2];
const store = new ContextStore(cwd);
const tools = new Map<string, any>(), handlers = new Map<string, any>();
register({ registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: any) { handlers.set(name, handler); } } as never, { home: `${cwd}/disposable-home` });
let replController: AbortController | undefined;
process.on("message", async (message: any) => {
  try {
    let value: unknown;
    if (message.op === "init") { await store.initialize(); value = true; }
    if (message.op === "capture") value = await store.capture("review", {}, { values: [1, 2] });
    if (message.op === "schema") value = await store.inspectSchema(message.id);
    if (message.op === "sql") value = await store.querySql(message.id, "SELECT values FROM evidence");
    if (message.op === "read") value = await store.readJson(message.id, "$.values");
    if (message.op === "jq") value = await store.queryJq(message.id, message.expression);
    if (message.op === "repl") {
      replController = new AbortController();
      try { value = await store.repl(message.input ?? { language: "bash", code: "echo fixture-ok" }, replController.signal); }
      catch (error) { if (!replController.signal.aborted) throw error; value = { available: true, exitCode: 1, cancelled: true }; }
    }
    if (message.op === "cancel") { replController?.abort(); return; }
    if (message.op === "hookCapture") value = await tools.get("context_capture").execute("review", { tool: "review", arguments: {}, payload: { values: [1, 2] } }, undefined, undefined, { cwd });
    if (message.op === "shutdown") { await handlers.get("session_shutdown")(); value = true; }
    process.send?.({ value });
  } catch (error) { process.send?.({ error: String(error) }); }
});
