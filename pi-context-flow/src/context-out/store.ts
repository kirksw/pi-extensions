import { createHash, randomUUID } from "node:crypto";
import type { ContextStore } from "../store.js";
import type { Observation } from "../types.js";
import { resolveContextOutIdentity, type ContextOutIdentity } from "./identity.js";
import { openContextOutEventWriter, replayContextOutEvents, ContextOutRetryConflictError, type ContextOutEventInput, type JsonValue } from "./events.js";
import { openContextOutProjection, type ContextOutProjection, type ProjectionQuery, type CandidateProposalPayload } from "./projection.js";
import { prepareObservationEvent } from "./provenance.js";
import { assessEvidence, supportCoverage, type EvidenceSnapshot } from "./availability.js";
import { dryRunLegacyMigration, importLegacyMigration } from "./migration.js";

const bare = (id: string) => id.replace(/^observation:\/\//, "");
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
const fingerprint = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const unknownMetadata = { branch: null, branchState: "unknown", revision: null, workingTree: "unknown" } as const;
export type LifecycleRequest = { observationId: string; action: "retract" | "supersede" | "link_support"; predecessorEventId: string; relatedObservationId?: string; reason?: string };

/** One service per extension instance. Writes (including lifecycle validation) are serialized. */
export class ContextOutStore {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private projections = new Map<string, ContextOutProjection>();
  constructor(private options: { home?: string; afterCommit?: () => Promise<void> } = {}) {}
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Context Out service is shut down"));
    const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next;
  }
  private async projection(identity: ContextOutIdentity) {
    const key = `${identity.repositoryId}:${identity.cloneId}:${identity.worktreeId}`;
    let projection = this.projections.get(key);
    if (!projection) { projection = await openContextOutProjection(identity); this.projections.set(key, projection); }
    else await projection.refresh();
    return projection;
  }
  private async commit(cwd: string, sessionId: string, key: string, request: unknown, prepare: (identity: ContextOutIdentity) => Promise<ContextOutEventInput>) {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("A real Pi session ID is required");
    const identity = await resolveContextOutIdentity(cwd, this.options);
    const writer = await openContextOutEventWriter(identity, sessionId);
    let event;
    let cleanupWarning: string | undefined;
    try {
      // Look up the committed semantic request before touching changing Git/evidence provenance.
      const existing = (await replayContextOutEvents(identity, sessionId)).records.find(r => r.event.idempotencyKey === key)?.event;
      const requestHash = fingerprint(request);
      if (existing) {
        const payload = existing.payload as Record<string, JsonValue>;
        if (payload.requestHash !== requestHash || existing.origin.cloneId !== identity.cloneId || existing.origin.worktreeId !== identity.worktreeId) throw new ContextOutRetryConflictError("Retry key already used with a different semantic request or origin");
        event = await writer.append(existing);
      } else {
        const input = await prepare(identity);
        event = await writer.append({ ...input, idempotencyKey: key, payload: { ...(input.payload as Record<string, JsonValue>), requestHash } });
      }
    } finally {
      try { await writer.close(); }
      catch (error) {
        if (!event) throw error;
        cleanupWarning = "Committed successfully; writer cleanup failed. Verify session lock ownership before recovery.";
      }
    }
    let warning: string | undefined = cleanupWarning;
    try { await this.options.afterCommit?.(); await this.projection(identity); }
    catch { warning = "Committed successfully; projection update pending. Retry with the same key or read again."; }
    return { version: 1, committed: true, subjectId: event.subjectId, eventId: event.eventId, timestamp: event.timestamp,
      ...(event.type === "candidate.proposed" ? { candidateId: event.subjectId, status: "proposed" } : { observationId: event.subjectId }), ...(warning ? { warning } : {}) };
  }
  observe(cwd: string, sessionId: string, key: string, input: Omit<Observation, "observationId" | "timestamp">, evidenceStore: () => Promise<ContextStore>) {
    const request = { text: input.text, category: input.category,
      evidenceIds: [...new Set(input.evidenceIds.map(id => id.replace(/^evidence:\/\//, "")))].sort(),
      queryIds: [...new Set(input.queryIds.map(id => id.replace(/^query:\/\//, "")))].sort() };
    return this.serialized(() => this.commit(cwd, sessionId, key, { operation: "observe", ...request }, async identity =>
      prepareObservationEvent(await evidenceStore(), identity, { ...request, observationId: `observation_${randomUUID()}`, idempotencyKey: key })));
  }
  promote(cwd: string, sessionId: string, key: string, input: CandidateProposalPayload) {
    const request = { observationId: bare(input.observationId), scope: input.scope, target: input.target, rationale: input.rationale };
    return this.serialized(() => this.commit(cwd, sessionId, key, { operation: "promote", ...request }, async identity => {
      if (!["repo", "architecture", "organization"].includes(request.scope) || !request.target.trim() || Buffer.byteLength(request.target) > 4096 || Buffer.byteLength(request.rationale) > 16384) throw new Error("Invalid candidate proposal");
      const observation = (await (await this.projection(identity)).read(request.observationId)).results[0];
      if (!observation || observation.state !== "active") throw new Error("Candidate requires an active observation owned by this worktree");
      return { type: "candidate.proposed", subjectId: `candidate_${randomUUID()}`, idempotencyKey: key, metadata: observation.metadata, payload: request };
    }));
  }
  lifecycle(cwd: string, sessionId: string, key: string, input: LifecycleRequest) {
    const request = { observationId: bare(input.observationId), action: input.action, predecessorEventId: input.predecessorEventId,
      relatedObservationId: input.relatedObservationId ? bare(input.relatedObservationId) : null, reason: input.reason ?? null };
    return this.serialized(() => this.commit(cwd, sessionId, key, { operation: "lifecycle", ...request }, async identity => {
      const projection = await this.projection(identity);
      const observation = (await projection.read(request.observationId)).results[0];
      if (!observation || observation.state !== "active" || observation.headEventId !== request.predecessorEventId) throw new Error("Lifecycle requires an active owned observation and its current predecessor event");
      if (!["retract", "supersede", "link_support"].includes(request.action) || (request.reason && Buffer.byteLength(request.reason) > 16384)) throw new Error("Invalid lifecycle request");
      if (request.action !== "retract") {
        const related = request.relatedObservationId && (await projection.read(request.relatedObservationId)).results[0];
        if (!related || related.observationId === observation.observationId || related.state !== "active") throw new Error("Support/replacement requires a different active observation owned by this worktree");
      }
      const payload = { predecessorEventId: request.predecessorEventId, ...(request.action === "retract" ? { reason: request.reason ?? "" }
        : request.action === "supersede" ? { replacementObservationId: request.relatedObservationId! } : { observationId: request.relatedObservationId! }) };
      return { type: request.action === "retract" ? "observation.retracted" : request.action === "supersede" ? "observation.superseded" : "support.linked",
        subjectId: request.observationId, idempotencyKey: key, metadata: observation.metadata ?? unknownMetadata, payload };
    }));
  }
  search(cwd: string, input: ProjectionQuery = {}, candidates = false) {
    return this.serialized(async () => {
      const projection = await this.projection(await resolveContextOutIdentity(cwd, this.options));
      return candidates ? projection.candidates({ ...input, responseBytes: 24000 }) : projection.search({ ...input, responseBytes: 24000 });
    });
  }
  read(cwd: string, observationId: string, input: { scope?: "worktree" | "repository"; assess?: boolean } = {}) {
    return this.serialized(async () => {
      const identity = await resolveContextOutIdentity(cwd, this.options), projection = await this.projection(identity);
      const page = await projection.read(observationId, { scope: input.scope, responseBytes: 24000 });
      const observation = page.results[0];
      if (!observation || !input.assess) return page;
      const event = (await replayContextOutEvents(identity)).records.find(r => r.event.eventId === observation.creationEventId)!.event;
      const payload = event.payload as unknown as { provenance: { evidence: EvidenceSnapshot[] } };
      const assessments = await assessEvidence(identity, observation.origin, payload.provenance.evidence);
      for (const id of observation.supportObservationIds) assessments.push({ reference: `observation://${id}`, status: "unverified", reason: "Linked claim not recursively inspected", coverage: "unknown", assessedAt: new Date().toISOString() });
      return { ...page, supportAssessment: { ...supportCoverage(assessments), assessments, omittedLinkedClaims: observation.supportLinksOmitted } };
    });
  }
  /** Byte-paged immutable snapshots/history allow inspecting a single large event without a giant row. */
  inspect(cwd: string, observationId: string, input: { scope?: "worktree" | "repository"; section: "provenance" | "history"; offset?: number }) {
    return this.serialized(async () => {
      const identity = await resolveContextOutIdentity(cwd, this.options), projection = await this.projection(identity);
      const page = await projection.read(observationId, { scope: input.scope });
      const observation = page.results[0]; if (!observation) throw new Error("Observation not found in selected scope");
      const events = (await replayContextOutEvents(identity)).records.map(r => r.event).filter(e => e.subjectId === observation.observationId).sort((a, b) => a.eventId.localeCompare(b.eventId));
      const value = input.section === "provenance" ? (events.find(e => e.eventId === observation.creationEventId)!.payload as Record<string, JsonValue>).provenance
        : events.map(({ payload, ...event }) => ({ ...event, payload: event.type === "observation.created" ? { snapshot: "Use provenance section" } : payload }));
      const serialized = JSON.stringify(value), offset = input.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > serialized.length) throw new Error("Invalid character offset");
      const chunk = serialized.slice(offset, offset + 2000);
      return { version: 1, observationId: observation.observationId, section: input.section, encoding: "JSON text; offsets are UTF-16 characters", offset, chunk,
        complete: offset + chunk.length === serialized.length, nextOffset: offset + chunk.length, totalCharacters: serialized.length, coverage: page.coverage };
    });
  }
  migrate(cwd: string, mode: "dry-run" | "import") {
    return this.serialized(async () => {
      const identity = await resolveContextOutIdentity(cwd, this.options);
      if (mode === "dry-run") return dryRunLegacyMigration(identity);
      if (mode !== "import") throw new Error("Invalid migration mode");
      return importLegacyMigration(identity);
    });
  }
  async close() {
    if (this.closed) return this.queue.then(() => {});
    this.closed = true;
    await this.queue;
    await Promise.all([...this.projections.values()].map(p => p.close())); this.projections.clear();
  }
}
