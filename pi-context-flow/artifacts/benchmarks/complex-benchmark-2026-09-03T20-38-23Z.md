# Complex Benchmark Report

| Scenario | Protocol | Configuration | Mechanism | Valid | Correct | Turns | Input tokens | Output tokens | Tool-result payload | Cost | Elapsed |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| github | file-reference | raw | read | valid | pass | 3 | 7298 | 109 | 992 bytes | $0.0000 | 6.9s |
| github | file-reference | context-mode | ctx_execute_file | valid | pass | 5 | 35901 | 1048 | 3246 bytes | $0.0000 | 30.9s |
| github | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 5215 | 55 | 826 bytes | $0.0000 | 4.8s |
| github | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 16904 | 73 | 826 bytes | $0.0000 | 7.6s |
| github | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | pass | 3 | 8048 | 486 | 880 bytes | $0.0000 | 18.7s |
| slack | file-reference | raw | read | valid | pass | 3 | 7268 | 162 | 995 bytes | $0.0000 | 8.4s |
| slack | file-reference | context-mode | ctx_execute_file | valid | pass | 2 | 8819 | 338 | 975 bytes | $0.0000 | 11.6s |
| slack | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 3657 | 106 | 828 bytes | $0.0000 | 5.7s |
| slack | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 16876 | 81 | 828 bytes | $0.0000 | 7.0s |
| slack | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | fail | 3 | 9002 | 526 | 881 bytes | $0.0000 | 16.1s |
| kubernetes | file-reference | raw | read | valid | pass | 2 | 1434 | 65 | 953 bytes | $0.0000 | 6.8s |
| kubernetes | file-reference | context-mode | ctx_execute_file | valid | pass | 2 | 8620 | 203 | 607 bytes | $0.0000 | 9.3s |
| kubernetes | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 3672 | 42 | 953 bytes | $0.0000 | 4.6s |
| kubernetes | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 9211 | 59 | 953 bytes | $0.0000 | 5.8s |
| kubernetes | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | pass | 3 | 2896 | 715 | 1021 bytes | $0.0000 | 21.2s |
| aws | file-reference | raw | read | valid | pass | 3 | 4656 | 105 | 1035 bytes | $0.0000 | 6.9s |
| aws | file-reference | context-mode | ctx_execute_file | valid | pass | 2 | 855 | 168 | 435 bytes | $0.0000 | 10.7s |
| aws | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 2076 | 39 | 874 bytes | $0.0000 | 5.4s |
| aws | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 1473 | 46 | 874 bytes | $0.0000 | 5.8s |
| aws | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | pass | 3 | 5289 | 546 | 935 bytes | $0.0000 | 16.6s |

Tool-result payload is measured as recorded bytes because Pi usage telemetry does not expose a tool-result token field.

## Run Details

### github / file-reference / raw

Tools: benchmark_reference_github, read



Open pull requests, most recently updated first:

- #104 — Fix retry backoff — author: `ada` — state: open

### github / file-reference / context-mode

Tools: ctx_execute_file, ctx_execute_file, ctx_execute_file, ctx_execute_file



Open pull requests, most recently updated first:

- #104 — Fix retry backoff — ada — open

### github / mcp-payload / raw

Tools: benchmark_emit_github



Open pull requests for `octo-org/widget-api`, most recently updated first:

- #104 — Fix retry backoff — author: `ada` — state: open

### github / mcp-payload / context-mode

Tools: benchmark_emit_github



Open pull requests for `octo-org/widget-api`, most recently updated first:

- #104 — Fix retry backoff — author: `ada` — state: open

### github / mcp-payload / context-flow

Tools: benchmark_emit_github, context_query_records



Open pull requests, most recently updated first:

- #104 — Fix retry backoff — ada — open

### slack / file-reference / raw

Tools: benchmark_reference_slack, read



- 1773133200.000100 — U-ADA: “Investigating the payment timeout”
- 1773133260.000200 — B-DEPLOY: “Deploy finished” — belongs to the thread rooted at `1773133200.000100` (U-ADA’s message).

### slack / file-reference / context-mode

Tools: ctx_execute_file



- `1773133200.000100` — `U-ADA`: “Investigating the payment timeout”
- `1773133260.000200` — `B-DEPLOY`: “Deploy finished” — this is a thread reply to the first message (`thread_ts: 1773133200.000100`).

### slack / mcp-payload / raw

Tools: benchmark_emit_slack



1. `1773133200.000100` — U-ADA: “Investigating the payment timeout”
2. `1773133260.000200` — B-DEPLOY: “Deploy finished”

The B-DEPLOY message belongs to the thread started by U-ADA’s message (`thread_ts: 1773133200.000100`).

### slack / mcp-payload / context-mode

Tools: benchmark_emit_slack



1. `U-ADA`: “Investigating the payment timeout”
2. `B-DEPLOY`: “Deploy finished” — this message belongs to the thread started by `U-ADA`’s message.

### slack / mcp-payload / context-flow

Tools: benchmark_emit_slack, context_query_records



The benchmark response did not include an `evidence://` URI. I attempted the available `evidence://slack` identifier unchanged, but it was not recognized, so no channel messages could be retrieved through the required record query.

### kubernetes / file-reference / raw

Tools: read



- `worker-4b2a` — namespace: `payments`; phase: `Pending`

### kubernetes / file-reference / context-mode

Tools: ctx_execute_file



- `worker-4b2a` — namespace: `payments` — phase: `Pending`

### kubernetes / mcp-payload / raw

Tools: benchmark_emit_kubernetes



- `worker-4b2a` — namespace: `payments` — phase: `Pending`

### kubernetes / mcp-payload / context-mode

Tools: benchmark_emit_kubernetes



- `worker-4b2a` — namespace: `payments` — phase: `Pending`

### kubernetes / mcp-payload / context-flow

Tools: benchmark_emit_kubernetes, context_query_records



- `worker-4b2a` — namespace: `payments` — phase: `Pending`

### aws / file-reference / raw

Tools: benchmark_reference_aws, read



- `r-001`
- `r-002`

### aws / file-reference / context-mode

Tools: ctx_execute_file



- `r-001`
- `r-002`

### aws / mcp-payload / raw

Tools: benchmark_emit_aws



r-001
r-002

### aws / mcp-payload / context-mode

Tools: benchmark_emit_aws



r-001
r-002

### aws / mcp-payload / context-flow

Tools: benchmark_emit_aws, context_query_records



- `r-001`
- `r-002`
