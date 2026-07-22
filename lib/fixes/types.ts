/** Shared contract between the report pipeline and any fix-generation provider. */

export type Impact = "critical" | "serious" | "moderate" | "minor";
export type Confidence = "high" | "medium" | "low";

export type WcagReference = { label: string; href: string };
export type Occurrence = { selector: string; html: string; failure: string };

/** One axe rule group, before a remediation has been attached. */
export type FindingInput = {
  ruleId: string;
  impact: Impact;
  title: string;
  explanation: string;
  wcag: WcagReference[];
  count: number;
  occurrences: Occurrence[];
};

export type FixSuggestion = {
  summary: string;
  whyItMatters: string;
  steps: string[];
  codeExample: string | null;
  confidence: Confidence;
  requiresManualReview: boolean;
  /** Provenance so a report can always say where its guidance came from. */
  provider: string;
  model: string;
  promptVersion: string;
};

export type Finding = FindingInput & { fix: FixSuggestion };

export interface FixProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Returns at most one remediation per rule group, keyed by ruleId.
   * Groups the provider cannot answer for are simply absent from the map —
   * callers fall back to deterministic guidance rather than failing the report.
   */
  generate(findings: FindingInput[]): Promise<Map<string, FixSuggestion>>;
}
