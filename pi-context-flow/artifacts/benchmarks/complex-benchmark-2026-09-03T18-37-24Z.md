# Complex Benchmark Report

| Scenario | Protocol | Configuration | Mechanism | Valid | Correct | Turns | Input tokens | Output tokens | Tool-result payload | Cost | Elapsed |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| linear | file-reference | raw | read | valid | pass | 4 | 41896 | 478 | 144156 bytes | $0.0987 | 17.4s |
| linear | file-reference | context-mode | ctx_execute_file | valid | pass | 6 | 9680 | 2909 | 11521 bytes | $0.0643 | 65.5s |
| linear | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 119785 | 225 | 453728 bytes | $0.2423 | 12.0s |
| linear | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 125844 | 195 | 453728 bytes | $0.2552 | 11.8s |
| linear | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | pass | 3 | 4934 | 327 | 1286 bytes | $0.0141 | 13.5s |
| github | file-reference | raw | read | valid | pass | 2 | 3221 | 65 | 826 bytes | $0.0072 | 7.9s |
| github | file-reference | context-mode | ctx_execute_file | valid | pass | 4 | 9697 | 576 | 2192 bytes | $0.0299 | 21.8s |
| github | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 1859 | 43 | 826 bytes | $0.0042 | 10.0s |
| github | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 7927 | 56 | 826 bytes | $0.0177 | 8.6s |
| github | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | pass | 3 | 3417 | 403 | 890 bytes | $0.0123 | 16.5s |
| slack | file-reference | raw | read | valid | pass | 2 | 3192 | 96 | 828 bytes | $0.0075 | 8.2s |
| slack | file-reference | context-mode | ctx_execute_file | valid | pass | 2 | 2076 | 409 | 1322 bytes | $0.0113 | 14.2s |
| slack | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 1825 | 62 | 828 bytes | $0.0044 | 7.3s |
| slack | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 7893 | 73 | 828 bytes | $0.0178 | 9.4s |
| slack | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | pass | 3 | 5231 | 697 | 896 bytes | $0.0191 | 21.7s |
| kubernetes | file-reference | raw | read | valid | pass | 2 | 3200 | 66 | 953 bytes | $0.0072 | 8.0s |
| kubernetes | file-reference | context-mode | ctx_execute_file | valid | pass | 2 | 1695 | 208 | 561 bytes | $0.0081 | 10.0s |
| kubernetes | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 1851 | 55 | 953 bytes | $0.0044 | 7.2s |
| kubernetes | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 7920 | 67 | 953 bytes | $0.0178 | 7.8s |
| kubernetes | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | pass | 3 | 2040 | 509 | 1011 bytes | $0.0111 | 16.7s |
| aws | file-reference | raw | read | valid | pass | 2 | 3144 | 54 | 874 bytes | $0.0069 | 9.1s |
| aws | file-reference | context-mode | ctx_execute_file | valid | pass | 2 | 1698 | 213 | 583 bytes | $0.0082 | 10.7s |
| aws | mcp-payload | raw | inline tool result (control) | valid | pass | 2 | 1788 | 40 | 874 bytes | $0.0041 | 7.8s |
| aws | mcp-payload | context-mode | inline tool result (control) | valid | pass | 2 | 2225 | 48 | 874 bytes | $0.0073 | 7.6s |
| aws | mcp-payload | context-flow | tool-result interception + Context Flow query | valid | pass | 3 | 1710 | 324 | 935 bytes | $0.0082 | 18.9s |

Tool-result payload is measured as recorded bytes because Pi usage telemetry does not expose a tool-result token field.

## Run Details

### linear / file-reference / raw

Tools: read, read, read



1. **PAY-104** — Webhook retries lose idempotency key; **In Progress**; **High**; created **2024-01-08**
2. **PAY-107** — Settlement export omits failed payouts; **Todo**; **Medium**; created **2024-01-13**
3. **PAY-112** — Card metadata migration blocks reconciliation; **Blocked**; **Urgent**; created **2024-01-19**

Excluded seemingly older records: **PAY-099** (created 2023-12-01) because it is **Done**; **PLA-001** (created 2023-11-01) because it belongs to the **platform** team, not the current **payments** team.

### linear / file-reference / context-mode

Tools: ctx_execute_file, ctx_execute_file, ctx_execute_file, ctx_execute_file, ctx_execute_file



Current team: **payments**

| Identifier | Title | State | Priority | Created |
|---|---|---|---|---|
| PAY-104 | Webhook retries lose idempotency key | In Progress | High | 2024-01-08 |
| PAY-107 | Settlement export omits failed payouts | Todo | Medium | 2024-01-13 |
| PAY-112 | Card metadata migration blocks reconciliation | Blocked | Urgent | 2024-01-19 |

Excluded older-looking records: **PLA-001** is for the platform team, and **PAY-099** is Done.

### linear / mcp-payload / raw

Tools: benchmark_emit_linear



| Identifier | Title | State | Priority | Created |
|---|---|---|---|---|
| PAY-104 | Webhook retries lose idempotency key | In Progress | High | 2024-01-08 |
| PAY-107 | Settlement export omits failed payouts | Todo | Medium | 2024-01-13 |
| PAY-112 | Card metadata migration blocks reconciliation | Blocked | Urgent | 2024-01-19 |

Excluded seemingly older records: PAY-099 (2023-12-01) because it is Done; PLA-001 (2023-11-01) because it belongs to the platform team, not payments.

### linear / mcp-payload / context-mode

Tools: benchmark_emit_linear



1. **PAY-104** — Webhook retries lose idempotency key; **In Progress**; **High**; created **2024-01-08**  
2. **PAY-107** — Settlement export omits failed payouts; **Todo**; **Medium**; created **2024-01-13**  
3. **PAY-112** — Card metadata migration blocks reconciliation; **Blocked**; **Urgent**; created **2024-01-19**

Excluded seemingly older records: **PAY-099** (created 2023-12-01) because it is **Done**; **PLA-001** (2023-11-01) because it belongs to the **platform** team, not the current **payments** team.

### linear / mcp-payload / context-flow

Tools: benchmark_emit_linear, context_query_records



Oldest non-Done Payments issues:

1. **PAY-104** — Webhook retries lose idempotency key — In Progress — High — 2024-01-08
2. **PAY-107** — Settlement export omits failed payouts — Todo — Medium — 2024-01-13
3. **PAY-112** — Card metadata migration blocks reconciliation — Blocked — Urgent — 2024-01-19

Excluded seemingly older records: **PAY-099** is Done, and **PLA-001** belongs to Platform rather than Payments.

### github / file-reference / raw

Tools: read



- #104 — Fix retry backoff — ada — open

### github / file-reference / context-mode

Tools: ctx_execute_file, ctx_execute_file, ctx_execute_file



- #104 — Fix retry backoff — ada — open

### github / mcp-payload / raw

Tools: benchmark_emit_github



- #104 — Fix retry backoff — ada — open

### github / mcp-payload / context-mode

Tools: benchmark_emit_github



- #104 — Fix retry backoff — ada — open

### github / mcp-payload / context-flow

Tools: benchmark_emit_github, context_query_records



Open pull requests (most recently updated first):

- #104 — Fix retry backoff — ada — open

### slack / file-reference / raw

Tools: read



1. **U-ADA** — “Investigating the payment timeout”  
2. **B-DEPLOY** — “Deploy finished” — belongs to the thread rooted at U-ADA’s message.

### slack / file-reference / context-mode

Tools: ctx_execute_file



Chronological channel messages:

1. **U-ADA:** Investigating the payment timeout  
2. **B-DEPLOY:** Deploy finished — thread reply to message 1

The second message belongs to a thread.

### slack / mcp-payload / raw

Tools: benchmark_emit_slack



1. U-ADA — “Investigating the payment timeout”
2. B-DEPLOY — “Deploy finished”

“Deploy finished” belongs to the thread started by “Investigating the payment timeout.”

### slack / mcp-payload / context-mode

Tools: benchmark_emit_slack



1. U-ADA: “Investigating the payment timeout”
2. B-DEPLOY: “Deploy finished” — belongs to the thread started by U-ADA’s message.

### slack / mcp-payload / context-flow

Tools: benchmark_emit_slack, context_query_records



1. U-ADA — “Investigating the payment timeout”
2. B-DEPLOY — “Deploy finished” *(thread reply to U-ADA’s message)*

### kubernetes / file-reference / raw

Tools: read



- `worker-4b2a` — namespace: `payments` — phase: `Pending`

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

Tools: read



r-001  
r-002

### aws / file-reference / context-mode

Tools: ctx_execute_file



r-001  
r-002

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



- r-001
- r-002
