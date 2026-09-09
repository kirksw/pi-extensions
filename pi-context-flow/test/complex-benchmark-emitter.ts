import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const scenarios = {
  incident: "complex-benchmarks/incident-log.log",
  linear: "complex-benchmarks/linear-mcp-response.json",
  revenue: "complex-benchmarks/datagrip-revenue-export.json",
  github: "record-query-stress/github-pulls.json",
  slack: "record-query-stress/slack-history.json",
  kubernetes: "record-query-stress/kubernetes-pods.json",
  aws: "record-query-stress/aws-ec2.json",
} as const;
const fixturesDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url));

export default function (pi: ExtensionAPI) {
  for (const [scenario, file] of Object.entries(scenarios)) {
    const fixture = `${fixturesDirectory}${file}`;
    pi.registerTool({
      name: `benchmark_emit_${scenario}`,
      label: `Emit ${scenario} Benchmark`,
      description: `Emit the deterministic ${scenario} benchmark payload for Context Flow interception testing.`,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text" as const, text: await readFile(fixture, "utf8") }], details: {} };
      },
    });
    pi.registerTool({
      name: `benchmark_reference_${scenario}`,
      label: `Reference ${scenario} Benchmark`,
      description: `Return the deterministic ${scenario} benchmark fixture path for file-reference testing.`,
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text" as const, text: `Benchmark fixture path: ${fixture}` }], details: {} };
      },
    });
  }
}
