/** Shared contract between the report pipeline and any fix-generation provider. */

export type Impact = "critical" | "serious" | "moderate" | "minor";
export type Confidence = "high" | "medium" | "low";

/**
 * How much authority a finding carries. `violation` means a rule mapped to a WCAG
 * 2.x A/AA success criterion — a real failure, and the only kind counted in the
 * report's headline totals. `advisory` means good practice that is not a WCAG
 * failure; it is reported separately and never inflates the score.
 */
export type FindingKind = "violation" | "advisory";

/**
 * What produced the finding. Today everything comes from axe. `heuristic` (our own
 * browser-driven checks, e.g. the focus-order walk) and `ai` (model-suggested, never
 * asserted as fact) are the planned additions — the report must keep them visually
 * distinct from what axe actually measured.
 */
export type FindingDetector = "axe" | "heuristic" | "ai";

export type WcagReference = { label: string; href: string };
export type Occurrence = { selector: string; html: string; failure: string };

/** One rule group, before a remediation has been attached. */
export type FindingInput = {
  ruleId: string;
  kind: FindingKind;
  detector: FindingDetector;
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
