export type EvidenceShape = "json" | "csv" | "tsv" | "xml" | "yaml" | "text" | "mixed";

export type EvidenceMetadata = {
  evidenceId: string;
  tool: string;
  arguments: unknown;
  timestamp: string;
  source: string;
  rawPath: string;
  sizeBytes: number;
  shape: EvidenceShape;
  sha256: string;
  dependencies: string[];
};

export type Observation = {
  observationId: string;
  text: string;
  category: "decision" | "constraint" | "failed_approach" | "relationship" | "unresolved_work" | "operational_knowledge" | "other";
  evidenceIds: string[];
  queryIds: string[];
  timestamp: string;
};

export type ArtifactCandidate = {
  candidateId: string;
  observationId: string;
  scope: "repo" | "architecture" | "organization";
  target: string;
  rationale: string;
  timestamp: string;
  status: "candidate";
};

export type EvidenceReference = Pick<EvidenceMetadata, "evidenceId" | "source" | "sizeBytes" | "shape" | "timestamp"> & {
  tools: string[];
};
