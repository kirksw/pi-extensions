import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Protocol = "file-reference" | "mcp-payload";
type Configuration = "raw" | "context-mode" | "context-flow";
type Usage = { input: number; output: number; toolResult: number; cost: number };
type Scenario = {
  id: "linear" | "github" | "slack" | "kubernetes" | "aws";
  fixture: string;
  expected: string[];
  request: string;
  flowQuery: string;
};
type RunResult = {
  scenario: Scenario["id"]; protocol: Protocol; configuration: Configuration; valid: boolean; correctness: "pass" | "fail";
  mechanism: string; turns: number; elapsedMs: number; usage: Usage; tools: string[]; answer: string; note?: string;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const emitter = join(root, "test/complex-benchmark-emitter.ts");
const contextFlow = join(root, "src/index.ts");
const contextMode = "/Users/kisw/.config/nix-agents/pi/bases/work/profiles/work-default/npm/node_modules/context-mode/build/adapters/pi/extension.js";
const litellmProvider = "/nix/store/im8f001l4mi77f2raq2cj3jmcyi51xcm-source/agents/packages/pi-litellm-provider/index.ts";
const outputDirectory = join(root, "artifacts/benchmarks");
const piCommand = process.env.PI_BENCHMARK_PI ?? "/etc/profiles/per-user/kisw/bin/pi";
const provider = process.env.PI_BENCHMARK_PROVIDER;
// Pi authenticates this model through its configured OpenAI Codex OAuth provider.
const model = process.env.PI_BENCHMARK_MODEL ?? "openai-codex/gpt-5.6-terra";
const scenarios: Scenario[] = [
  {
    id: "linear", fixture: "complex-benchmarks/linear-mcp-response.json",
    expected: ["PAY-104", "PAY-107", "PAY-112", "PAY-099", "PLA-001"],
    request: "Give the three oldest non-Done issues for the current team, ordered oldest first, with identifier, title, state, priority, and creation date. Briefly state which seemingly older records were excluded and why.",
    flowQuery: 'Use collectionHint "issues"; filters team.name = "payments" and state.name oneOf ["Todo", "In Progress", "Blocked"]; select exactly ["identifier", "title", "state.name", "priority", "createdAt"]; orderBy exactly [{"field":"createdAt","direction":"asc"}]; limit 3. State that PAY-099 is Done and PLA-001 belongs to platform.',
  },
  {
    id: "github", fixture: "record-query-stress/github-pulls.json",
    expected: ["104", "Fix retry backoff", "open", "ada"],
    request: "Report every open pull request, ordered by most recently updated first, with number, title, author, and state. Do not report closed pull requests.",
    flowQuery: 'Use collectionHint "pulls"; filters state = "open"; select exactly ["number", "title", "user.login", "state", "updated_at"]; orderBy exactly [{"field":"updated_at","direction":"desc"}]; limit 10.',
  },
  {
    id: "slack", fixture: "record-query-stress/slack-history.json",
    expected: ["U-ADA", "Investigating the payment timeout", "B-DEPLOY", "Deploy finished"],
    request: "List the channel messages in chronological order with sender and text. State which message belongs to a thread, if any.",
    flowQuery: 'Use collectionHint "messages"; filters type = "message"; select exactly ["user", "text", "ts", "thread_ts"]; orderBy exactly [{"field":"ts","direction":"asc"}]; limit 10.',
  },
  {
    id: "kubernetes", fixture: "record-query-stress/kubernetes-pods.json",
    expected: ["worker-4b2a", "payments", "Pending"],
    request: "Report every non-running pod with its name, namespace, and phase. Do not include running pods.",
    flowQuery: 'Use collectionHint "items"; filters status.phase = "Pending"; select exactly ["metadata.name", "metadata.namespace", "status.phase"]; orderBy exactly [{"field":"metadata.name","direction":"asc"}]; limit 10.',
  },
  {
    id: "aws", fixture: "record-query-stress/aws-ec2.json",
    expected: ["r-001", "r-002"],
    request: "List the reservation IDs in ascending order.",
    flowQuery: 'Use collectionHint "Reservations"; select exactly ["ReservationId"]; orderBy exactly [{"field":"ReservationId","direction":"asc"}]; limit 10.',
  },
];
const configurations: Record<Protocol, Configuration[]> = {
  "file-reference": ["raw", "context-mode"],
  "mcp-payload": ["raw", "context-mode", "context-flow"],
};

function argumentsFor(configuration: Configuration, protocol: Protocol): string[] {
  const args = ["--model", model, "--thinking", "medium", "--mode", "json", "--print", "--no-extensions", "--no-context-files", "--no-skills", "--approve"];
  if (provider) args.unshift("--provider", provider);
  if (provider === "litellm") args.push("-e", litellmProvider);
  if (configuration === "raw") {
    if (protocol === "mcp-payload") args.push("--no-builtin-tools");
    args.push("-e", emitter);
  } else if (configuration === "context-mode") {
    args.push("--no-builtin-tools", "-e", contextMode);
    if (protocol === "mcp-payload") args.push("-e", emitter);
  } else args.push("--no-builtin-tools", "-e", contextFlow, "-e", emitter);
  return args;
}

function promptFor(scenario: Scenario, configuration: Configuration, protocol: Protocol): string {
  if (protocol === "file-reference") {
    const tool = configuration === "raw" ? "read" : "ctx_execute_file";
    return `Analyze only fixtures/${scenario.fixture} with ${tool}. ${scenario.request}`;
  }
  if (configuration === "context-flow") return `Call benchmark_emit_${scenario.id} once. Then use its returned evidence:// URI unchanged and call context_query_records exactly once (no context_schema or SQL). ${scenario.flowQuery} ${scenario.request}`;
  if (configuration === "context-mode") return `Call benchmark_emit_${scenario.id} once. This is a control for inline MCP payload handling; do not use context-mode analysis tools. ${scenario.request}`;
  return `Call benchmark_emit_${scenario.id} once. ${scenario.request}`;
}

async function runProcess(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
  const started = performance.now();
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CONTEXT_MODE_PROJECT_DIR: cwd }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr, elapsedMs: Math.round(performance.now() - started) }) : reject(new Error(`pi exited ${code}: ${stderr}`)));
  });
}

function parseRun(scenario: Scenario, protocol: Protocol, configuration: Configuration, output: string, elapsedMs: number): RunResult {
  const events = output.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const end = [...events].reverse().find((event: any) => event.type === "agent_end");
  const messages = end?.messages ?? [];
  const assistants = messages.filter((message: any) => message.role === "assistant");
  const toolResults = messages.filter((message: any) => message.role === "toolResult");
  const tools = assistants.flatMap((message: any) => (message.content ?? []).filter((item: any) => item.type === "toolCall").map((item: any) => item.name));
  const answer = assistants.at(-1)?.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("") ?? "";
  const usage = assistants.reduce((total: Usage, message: any) => ({
    input: total.input + (message.usage?.input ?? 0), output: total.output + (message.usage?.output ?? 0), toolResult: total.toolResult,
    cost: total.cost + (message.usage?.cost?.total ?? 0),
  }), { input: 0, output: 0, toolResult: 0, cost: 0 });
  usage.toolResult = toolResults.reduce((total: number, message: any) => total + JSON.stringify(message.content ?? "").length, 0);
  const mechanism = protocol === "file-reference" ? (configuration === "raw" ? "read" : "ctx_execute_file") : (configuration === "context-flow" ? "tool-result interception + Context Flow query" : "inline tool result (control)");
  const requiredTool = protocol === "file-reference" ? (configuration === "raw" ? "read" : "ctx_execute_file") : (configuration === "context-flow" ? "context_query_records" : `benchmark_emit_${scenario.id}`);
  let valid = tools.includes(requiredTool) && (protocol !== "mcp-payload" || tools.includes(`benchmark_emit_${scenario.id}`));
  let note: string | undefined = valid ? undefined : `Required tool not observed: ${requiredTool}`;
  if (valid && protocol === "mcp-payload" && configuration === "context-flow") {
    // The mechanism is only real when interception replaced the emitted payload and the record query succeeded.
    const intercepted = toolResults.some((message: any) => message.toolName === `benchmark_emit_${scenario.id}` && JSON.stringify(message.content).includes("evidence://"));
    const queryResults = toolResults.filter((message: any) => message.toolName === "context_query_records");
    const querySucceeded = queryResults.length > 0 && queryResults.every((message: any) => !message.isError);
    if (!intercepted || !querySucceeded) {
      valid = false;
      note = !intercepted ? "Interception did not fire: emitted tool result contains no evidence:// reference." : "context_query_records failed; the run did not use the Context Flow mechanism.";
    }
  }
  const correctness = scenario.expected.every((value) => answer.includes(value)) ? "pass" : "fail";
  return { scenario: scenario.id, protocol, configuration, valid, correctness, mechanism, turns: assistants.length, elapsedMs, usage, tools, answer, note };
}

async function execute(scenario: Scenario, protocol: Protocol, configuration: Configuration, index: number): Promise<RunResult> {
  const workspace = await mkdtemp(join(tmpdir(), `pi-benchmark-${scenario.id}-${protocol}-${configuration}-${index}-`));
  try {
    if (protocol === "file-reference") {
      const destination = join(workspace, "fixtures", scenario.fixture);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(root, "fixtures", scenario.fixture), destination);
    }
    const completed = await runProcess(piCommand, argumentsFor(configuration, protocol).concat(promptFor(scenario, configuration, protocol)), workspace);
    return parseRun(scenario, protocol, configuration, completed.stdout, completed.elapsedMs);
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

function markdown(results: RunResult[]): string {
  const rows = results.map((result) => `| ${result.scenario} | ${result.protocol} | ${result.configuration} | ${result.mechanism} | ${result.valid ? "valid" : "invalid"} | ${result.correctness} | ${result.turns} | ${result.usage.input} | ${result.usage.output} | ${result.usage.toolResult} bytes | $${result.usage.cost.toFixed(4)} | ${(result.elapsedMs / 1000).toFixed(1)}s |`);
  return ["# Complex Benchmark Report", "", "| Scenario | Protocol | Configuration | Mechanism | Valid | Correct | Turns | Input tokens | Output tokens | Tool-result payload | Cost | Elapsed |", "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |", ...rows, "", "Tool-result payload is measured as recorded bytes because Pi usage telemetry does not expose a tool-result token field.", "", "## Run Details", ...results.map((result) => `\n### ${result.scenario} / ${result.protocol} / ${result.configuration}\n\nTools: ${result.tools.join(", ") || "none"}\n\n${result.note ?? ""}\n\n${result.answer}`)].join("\n");
}

const runs = Number(process.argv.find((arg) => arg.startsWith("--runs="))?.split("=")[1] ?? "1");
const concurrency = Number(process.argv.find((arg) => arg.startsWith("--concurrency="))?.split("=")[1] ?? "4");
const selected = process.argv.find((arg) => arg.startsWith("--scenarios="))?.split("=")[1]?.split(",") ?? scenarios.map((scenario) => scenario.id);
const selectedScenarios = scenarios.filter((scenario) => selected.includes(scenario.id));
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
if (!selectedScenarios.length || selectedScenarios.length !== selected.length) throw new Error(`--scenarios must name one or more of: ${scenarios.map((scenario) => scenario.id).join(", ")}`);
const combinations: Array<{ scenario: Scenario; protocol: Protocol; configuration: Configuration; index: number }> = [];
for (let index = 1; index <= runs; index++) for (const scenario of selectedScenarios) for (const protocol of Object.keys(configurations) as Protocol[]) for (const configuration of configurations[protocol]) combinations.push({ scenario, protocol, configuration, index });
const results: RunResult[] = new Array(combinations.length);
let next = 0;
const worker = async () => {
  while (next < combinations.length) {
    const slot = next++;
    const current = combinations[slot];
    process.stderr.write(`Running ${current.scenario.id}/${current.protocol}/${current.configuration} (${current.index}/${runs})...\n`);
    results[slot] = await execute(current.scenario, current.protocol, current.configuration, current.index);
  }
};
await Promise.all(Array.from({ length: Math.min(concurrency, combinations.length) }, worker));
await mkdir(outputDirectory, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
await writeFile(join(outputDirectory, `complex-benchmark-${stamp}.json`), JSON.stringify(results, null, 2) + "\n");
await writeFile(join(outputDirectory, `complex-benchmark-${stamp}.md`), markdown(results) + "\n");
process.stdout.write(markdown(results) + "\n");
