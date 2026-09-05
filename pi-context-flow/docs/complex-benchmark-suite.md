# Complex Benchmark Suite

This suite compares Raw Pi, Context Mode, and Context Flow on synthetic but lifelike large tool results.

## Invariants

- Use a clean Pi session, the same model and thinking level, and the same prompt for every configuration.
- Use the emitter extension for every configuration. Do not grant unrelated file or shell tools.
- The emitted-payload protocol measures Context Flow interception. The file-reference protocol measures Raw Pi and Context Mode using their natural artifact access paths.
- A run is invalid unless it uses the designated access mechanism for its protocol.
- Require correctness before comparing efficiency.
- Record source bytes, model turns, tool calls, input/output/tool-result tokens, elapsed time, cost, answer, and pass result.
- Evaluate only source-grounded claims. Treat unsupported causal statements or omitted required results as failures.
- Establish token, turn, and cost ceilings from a passing baseline before enforcing them as regression gates.

## Fixtures

Generate the fixtures before a run:

```bash
npx tsx test/generate-complex-benchmark-fixtures.ts
```

| Scenario | Emitter tool | Required conclusion |
| --- | --- | --- |
| Incident log | `benchmark_emit_incident` | Identify the silent empty-invoice bug, request ID, first failure time, release, causal code path, and a safe next investigation. Ignore unrelated timeouts and worker retries. |
| Linear MCP | `benchmark_emit_linear` | Identify the three oldest non-Done issues for the current `payments` team, in creation order; exclude the old Done issue and the older cross-team issue. |
| Revenue export | `benchmark_emit_revenue` | Calculate recognized February USD revenue: paid invoice subtotals excluding tax, less succeeded refunds, deduplicating payment retries and converting EUR at the supplied rate. Explain exclusions. |
| GitHub pulls | `benchmark_emit_github` | List open pull requests by most-recent update with number, title, author, and state; exclude closed pulls. |
| Slack history | `benchmark_emit_slack` | List channel messages chronologically with sender and text; identify a threaded reply. |
| Kubernetes pods | `benchmark_emit_kubernetes` | List non-running pods with name, namespace, and phase; exclude running pods. |
| AWS EC2 | `benchmark_emit_aws` | List reservation IDs in ascending order. |

Each `benchmark_emit_<scenario>` also has a `benchmark_reference_<scenario>` companion that returns only the immutable fixture path. Use it for the file-reference protocol.

`fixtures/complex-benchmarks/oracle.json` records exact planted facts. The broad generated background data makes a full-output context problem rather than a small hand-picked example.

## Suggested Prompts

### Incident

```text
Call benchmark_emit_incident once. Analyze the returned operational log. Give a short incident note: user-visible bug, request ID, first failing event time, deployed release, causal code path, and one safe next investigation. Distinguish evidence from hypotheses and ignore unrelated errors.
```

### Linear

```text
Call benchmark_emit_linear once. The response identifies the current user and team. Give the three oldest non-Done issues for the current team, ordered oldest first, with identifier, title, state, priority, and creation date. Briefly state which seemingly older records were excluded and why.
```

### Revenue

```text
Call benchmark_emit_revenue once. Calculate recognized February 2026 revenue in USD from this DataGrip export. Count paid invoice subtotals only, exclude tax and voids, subtract succeeded refunds, deduplicate retry payment events, and convert non-USD invoices using the supplied rates. Give the total, a compact calculation table, and the main sources of variance from naive gross invoice totals.
```

For Context Flow, add: use the returned `evidence://` reference unchanged and only Context Flow tools afterward.

### Linear File-Reference Protocol

```text
Call benchmark_reference_linear once. It returns the fixture path. Analyze only that file through your designated artifact access tool: Raw Pi uses its normal read tool; Context Mode must use ctx_execute_file. Give the three oldest non-Done issues for the current team, ordered oldest first, with identifier, title, state, priority, and creation date. Briefly state which seemingly older records were excluded and why.
```

This protocol has the same fixture and answer semantics as the emitted-payload Linear test, but tests each system's natural file handoff rather than Context Flow interception.

## API Schema Stress Scenarios

The headless runner also covers deterministic GitHub, Slack, Kubernetes, and AWS-shaped fixtures in `fixtures/record-query-stress`.
Each scenario runs all file-reference and MCP-payload configurations with the same answer semantics.
Context Flow is required to use one `context_query_records` call after its emitter tool, so these cases measure the constrained record-query fast path rather than schema or SQL fallback behavior.

Run only these scenarios when iterating locally:

```bash
npm run benchmark:complex -- --scenarios=github,slack,kubernetes,aws
```

The `--scenarios` option also accepts `linear` and can be combined with `--runs=N`.

## Scorecard

| Dimension | Pass rule |
| --- | --- |
| Correctness | All required oracle facts and numerical values are present. |
| Completeness | Every requested output field is present. |
| Grounding | No unsupported root cause, exclusion, or operational recommendation. |
| Efficiency | Under the scenario ceiling after a passing baseline is approved. |

