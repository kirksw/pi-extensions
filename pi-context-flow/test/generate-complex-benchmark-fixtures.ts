import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixtures = join(process.cwd(), "fixtures", "complex-benchmarks");
const stressFixtures = join(process.cwd(), "fixtures", "record-query-stress");

async function writeJson(name: string, value: unknown) {
  await writeFile(join(fixtures, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeStressJson(name: string, value: unknown) {
  await writeFile(join(stressFixtures, name), `${JSON.stringify(value, null, 2)}\n`);
}

function iso(day: number, hour = 9) {
  return `2026-02-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00.000Z`;
}

async function main() {
  await mkdir(fixtures, { recursive: true });
  await mkdir(stressFixtures, { recursive: true });

  const logLines: string[] = [];
  for (let index = 1; index <= 2800; index += 1) {
    const timestamp = `2026-02-18T${String(Math.floor(index / 60) % 24).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;
    logLines.push(`${timestamp} INFO api request_complete request_id=req-${String(index).padStart(5, "0")} route=/v1/search status=200 duration_ms=${20 + (index % 80)}`);
    if (index % 97 === 0) logLines.push(`${timestamp} WARN worker retry_scheduled job=sync_catalog attempt=1 reason=upstream_429`);
    if (index % 211 === 0) logLines.push(`${timestamp} ERROR db query_timeout request_id=req-${String(index).padStart(5, "0")} pool=analytics duration_ms=30000`);
  }
  logLines.splice(380, 0,
    "2026-02-18T09:14:03.221Z INFO api request_start request_id=req-incident-001 route=/v1/invoices tenant=acme-web client_version=2026.02.18",
    "2026-02-18T09:14:03.236Z DEBUG billing serialize_invoice request_id=req-incident-001 tenant_id=acme-web schema_version=42",
    "2026-02-18T09:14:03.241Z ERROR billing TypeError request_id=req-incident-001 error=Cannot_read_properties_of_undefined_reading_currency stack=InvoiceSerializer.toWire@billing.js:481",
    "2026-02-18T09:14:03.243Z WARN api fallback_response request_id=req-incident-001 route=/v1/invoices status=200 body={invoices:[]}",
    "2026-02-18T09:14:03.244Z INFO api request_complete request_id=req-incident-001 route=/v1/invoices status=200 duration_ms=23",
    "2026-02-18T09:14:07.001Z INFO deploy release=2026.02.18.1 component=billing change=tenant_id_serialization",
  );
  await writeFile(join(fixtures, "incident-log.log"), `${logLines.join("\n")}\n`);

  const teams = ["platform", "payments", "mobile"];
  const issues: Array<{ id: string; identifier: string; title: string; team: { id: string; name: string }; state: { name: string }; priority: string; createdAt: string; updatedAt: string; assignee: { id: string; name: string }; labels: string[] }> = Array.from({ length: 800 }, (_, index) => ({
    id: `issue-${index + 1}`,
    identifier: `${teams[index % teams.length].slice(0, 3).toUpperCase()}-${index + 1}`,
    title: `Routine backlog item ${index + 1}`,
    team: { id: teams[index % teams.length], name: teams[index % teams.length] },
    state: { name: index % 9 === 0 ? "Done" : "Todo" },
    priority: ["No priority", "Low", "Medium", "High"][index % 4],
    createdAt: iso((index % 27) + 1),
    updatedAt: iso((index % 27) + 1, 12),
    assignee: { id: `user-${index % 14}`, name: `User ${index % 14}` },
    labels: [],
  }));
  issues.push(
    { id: "issue-old-pay-1", identifier: "PAY-104", title: "Webhook retries lose idempotency key", team: { id: "payments", name: "payments" }, state: { name: "In Progress" }, priority: "High", createdAt: "2024-01-08T10:00:00.000Z", updatedAt: "2026-02-10T09:00:00.000Z", assignee: { id: "me", name: "Current User" }, labels: ["customer-impact"] },
    { id: "issue-old-pay-2", identifier: "PAY-107", title: "Settlement export omits failed payouts", team: { id: "payments", name: "payments" }, state: { name: "Todo" }, priority: "Medium", createdAt: "2024-01-13T10:00:00.000Z", updatedAt: "2026-02-09T09:00:00.000Z", assignee: { id: "user-7", name: "User 7" }, labels: ["backlog"] },
    { id: "issue-old-pay-3", identifier: "PAY-112", title: "Card metadata migration blocks reconciliation", team: { id: "payments", name: "payments" }, state: { name: "Blocked" }, priority: "Urgent", createdAt: "2024-01-19T10:00:00.000Z", updatedAt: "2026-02-15T09:00:00.000Z", assignee: { id: "me", name: "Current User" }, labels: ["blocked"] },
    { id: "issue-excluded-closed", identifier: "PAY-099", title: "Old resolved payment issue", team: { id: "payments", name: "payments" }, state: { name: "Done" }, priority: "High", createdAt: "2023-12-01T10:00:00.000Z", updatedAt: "2024-01-01T09:00:00.000Z", assignee: { id: "me", name: "Current User" }, labels: [] },
    { id: "issue-excluded-other", identifier: "PLA-001", title: "Old platform issue", team: { id: "platform", name: "platform" }, state: { name: "Todo" }, priority: "Urgent", createdAt: "2023-11-01T10:00:00.000Z", updatedAt: "2026-01-01T09:00:00.000Z", assignee: { id: "me", name: "Current User" }, labels: [] },
  );
  await writeJson("linear-mcp-response.json", { jsonrpc: "2.0", id: "linear-issues-42", result: { currentUser: { id: "me", name: "Current User" }, currentTeam: { id: "payments", name: "payments" }, issues, pageInfo: { hasNextPage: false, totalCount: issues.length } } });

  const invoices = Array.from({ length: 1300 }, (_, index) => ({
    invoice_id: `inv-${String(index + 1).padStart(5, "0")}`,
    issued_at: iso((index % 27) + 1),
    currency: index % 3 === 0 ? "EUR" : "USD",
    subtotal: 100 + (index % 19) * 10,
    tax: 10 + (index % 7),
    status: index % 31 === 0 ? "void" : "paid",
    payment_id: `pay-${String(index + 1).padStart(5, "0")}`,
  }));
  invoices.push(
    { invoice_id: "inv-target-usd", issued_at: "2026-02-05T10:00:00.000Z", currency: "USD", subtotal: 10000, tax: 900, status: "paid", payment_id: "pay-target-usd" },
    { invoice_id: "inv-target-eur", issued_at: "2026-02-10T10:00:00.000Z", currency: "EUR", subtotal: 5000, tax: 450, status: "paid", payment_id: "pay-target-eur" },
    { invoice_id: "inv-void", issued_at: "2026-02-11T10:00:00.000Z", currency: "USD", subtotal: 7000, tax: 630, status: "void", payment_id: "pay-void" },
  );
  const refunds = [
    { refund_id: "ref-target", invoice_id: "inv-target-usd", refunded_at: "2026-02-15T10:00:00.000Z", amount: 1200, currency: "USD", status: "succeeded" },
    { refund_id: "ref-failed", invoice_id: "inv-target-eur", refunded_at: "2026-02-15T10:00:00.000Z", amount: 300, currency: "EUR", status: "failed" },
  ];
  const payments = invoices.flatMap((invoice) => [
    { payment_event_id: `evt-${invoice.payment_id}`, payment_id: invoice.payment_id, invoice_id: invoice.invoice_id, event: "captured", occurred_at: invoice.issued_at },
    ...(invoice.invoice_id === "inv-target-usd" ? [{ payment_event_id: "evt-pay-target-usd-retry", payment_id: invoice.payment_id, invoice_id: invoice.invoice_id, event: "captured", occurred_at: "2026-02-05T10:01:00.000Z" }] : []),
  ]);
  await writeJson("datagrip-revenue-export.json", { export: { source: "DataGrip", table: "billing" }, period: "2026-02", fx_rates: [{ currency: "USD", usd_rate: 1 }, { currency: "EUR", usd_rate: 1.1 }], invoices, refunds, payments });

  // Record-query stress fixtures: broad deterministic background data keeps every emitted payload far above
  // Context Flow's 8 KiB auto-capture threshold, so interception deterministically fires, while the planted
  // records below stay the complete answer for each scenario.
  const githubUsers = ["lin", "bea", "sam", "kim"];
  const backgroundPulls = Array.from({ length: 150 }, (_, index) => ({
    number: 110 + index,
    title: `Routine maintenance ${index + 1}`,
    state: "closed",
    draft: false,
    updated_at: `2026-02-${String((index % 27) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00Z`,
    user: { login: githubUsers[index % githubUsers.length] },
    milestone: null,
    labels: [],
    assignees: [],
  }));
  await writeStressJson("github-pulls.json", {
    repository: { full_name: "octo-org/widget-api" },
    pulls: [
      { number: 104, title: "Fix retry backoff", state: "open", draft: false, updated_at: "2026-03-10T09:00:00Z", user: { login: "ada" }, milestone: null, labels: [{ name: "bug", color: "d73a4a" }], assignees: [{ login: "lin" }] },
      { number: 101, title: "Archive old endpoint", state: "closed", draft: false, updated_at: "2026-03-08T09:00:00Z", user: { login: "bea" }, milestone: { title: "v2" }, labels: [], assignees: [] },
      ...backgroundPulls,
    ],
    next_page: null,
  });

  const slackUsers = ["U-LIN", "U-BEA"];
  const slackTexts = ["Standup notes", "On-call handoff summary", "Invoice sync report", "Capacity planning update", "Release checklist item"];
  const backgroundMessages = Array.from({ length: 150 }, (_, index) => ({
    type: "message",
    user: slackUsers[index % slackUsers.length],
    text: `${slackTexts[index % slackTexts.length]} ${index + 1}`,
    ts: `${1773133320 + index * 60}.${String(300 + index).padStart(6, "0")}`,
    thread_ts: null,
    reactions: index % 5 === 0 ? [{ name: "eyes", count: 1, users: ["U-BEA"] }] : [],
    blocks: [],
  }));
  await writeStressJson("slack-history.json", {
    ok: true,
    messages: [
      { type: "message", user: "U-ADA", text: "Investigating the payment timeout", ts: "1773133200.000100", thread_ts: null, reactions: [{ name: "eyes", count: 2, users: ["U-LIN", "U-BEA"] }], blocks: [{ type: "section", text: { type: "mrkdwn", text: "Investigating" } }] },
      { type: "message", subtype: "bot_message", user: "B-DEPLOY", text: "Deploy finished", ts: "1773133260.000200", thread_ts: "1773133200.000100", reactions: [], blocks: [] },
      ...backgroundMessages,
    ],
    response_metadata: { next_cursor: "cursor-next-page" },
  });

  const podPrefixes = ["api", "worker", "web"];
  const podNamespaces = ["payments", "platform", "mobile"];
  const backgroundPods = Array.from({ length: 120 }, (_, index) => {
    const suffix = ((index * 7919) % 65536).toString(16).padStart(4, "0");
    const prefix = podPrefixes[index % podPrefixes.length];
    return {
      metadata: { name: `${prefix}-${suffix}`, namespace: podNamespaces[index % podNamespaces.length], labels: { "app.kubernetes.io/name": prefix, team: podNamespaces[index % podNamespaces.length] } },
      spec: { containers: [{ name: prefix, image: `registry.example/${prefix}:42` }] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    };
  });
  await writeStressJson("kubernetes-pods.json", {
    apiVersion: "v1",
    kind: "PodList",
    items: [
      { metadata: { name: "api-7c9d", namespace: "payments", labels: { "app.kubernetes.io/name": "api", team: "payments" } }, spec: { containers: [{ name: "api", image: "registry.example/api:42" }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
      { metadata: { name: "worker-4b2a", namespace: "payments", labels: { "app.kubernetes.io/name": "worker", team: "payments" } }, spec: { containers: [{ name: "worker", image: "registry.example/worker:42" }] }, status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] } },
      ...backgroundPods,
    ],
  });

  const instanceTypes = ["t3.small", "t3.medium", "t3.large"];
  const backgroundInstances = (offset: number) => Array.from({ length: 110 }, (_, index) => ({
    InstanceId: `i-${String(offset + index).padStart(4, "0")}`,
    State: { Name: index % 4 === 0 ? "stopped" : "running" },
    InstanceType: instanceTypes[index % instanceTypes.length],
    Tags: [{ Key: "Name", Value: `background-${offset + index}` }],
    NetworkInterfaces: [],
  }));
  await writeStressJson("aws-ec2.json", {
    Reservations: [
      { ReservationId: "r-001", Instances: [{ InstanceId: "i-001", State: { Name: "running" }, InstanceType: "t3.medium", Tags: [{ Key: "Name", Value: "payments-api" }], NetworkInterfaces: [{ NetworkInterfaceId: "eni-001", PrivateIpAddress: "10.0.0.10" }] }, ...backgroundInstances(100)] },
      { ReservationId: "r-002", Instances: [{ InstanceId: "i-002", State: { Name: "stopped" }, InstanceType: "t3.small", Tags: [{ Key: "Name", Value: "batch-worker" }], NetworkInterfaces: [] }, ...backgroundInstances(300)] },
    ],
    NextToken: "next-page-token",
  });

  await writeJson("oracle.json", {
    incident: { requestId: "req-incident-001", route: "/v1/invoices", version: "2026.02.18.1", bug: "tenant_id serialization regression causes InvoiceSerializer.toWire to read an undefined currency; fallback returns an empty invoice list with HTTP 200", firstFailure: "2026-02-18T09:14:03.241Z" },
    linear: { team: "payments", oldestOpen: ["PAY-104", "PAY-107", "PAY-112"], excluded: ["PAY-099", "PLA-001"] },
    revenue: { rules: "paid invoices only; subtotal excluding tax; subtract succeeded refunds; deduplicate payment retries; convert EUR at 1.1", targetAdjustmentsUsd: { paidSubtotal: 15500, succeededRefunds: 1200, net: 14300 } },
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
