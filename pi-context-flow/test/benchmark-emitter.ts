import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "benchmark_emit_payload",
    label: "Emit Benchmark Payload",
    description: "Emit the fixed 500 KiB benchmark JSON payload for Context Flow interception testing.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: await readFile("fixtures/benchmark-500k.json", "utf8") }], details: {} };
    },
  });
}
