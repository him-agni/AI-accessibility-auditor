/**
 * Maps raw axe-core output onto the report shape the product already renders.
 *
 * Everything here treats axe output as untrusted: it describes a third-party page,
 * and its strings reach both the report UI and the fix-generation prompt. Snippets
 * are bounded, and no complete page HTML is ever retained.
 */
import type { FindingInput, FindingKind, Impact, Occurrence, WcagReference } from "../fixes/types";

/** Bounded so a hostile page cannot bloat a stored report or a model prompt. */
const MAX_OCCURRENCES_STORED = 5;
const MAX_HTML_CHARS = 400;
const MAX_SELECTOR_CHARS = 200;
const MAX_FAILURE_CHARS = 400;
const MAX_TITLE_CHARS = 200;
const MAX_EXPLANATION_CHARS = 500;
/**
 * A page with hundreds of distinct rule failures is still only worth one report.
 * Capped per kind so a flood of advisories can never crowd out real violations.
 */
const MAX_VIOLATION_GROUPS = 25;
const MAX_ADVISORY_GROUPS = 15;

/**
 * The tags that make a rule a WCAG failure rather than a recommendation. A rule
 * carrying any of these is reported as a `violation`; everything else axe returns
 * (its `best-practice` set) is an `advisory` and never counts toward the totals.
 */
const WCAG_TAGS = new Set(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);

export function classify(tags: unknown): FindingKind {
  const list = Array.isArray(tags) ? tags : [];
  return list.some((tag) => typeof tag === "string" && WCAG_TAGS.has(tag)) ? "violation" : "advisory";
}

const IMPACTS: Impact[] = ["critical", "serious", "moderate", "minor"];
const IMPACT_ORDER = new Map(IMPACTS.map((impact, index) => [impact, index]));

/** Shape of the fields we consume from an axe `violations[]` entry. */
export type AxeNode = {
  target?: unknown;
  html?: unknown;
  failureSummary?: unknown;
  impact?: unknown;
};

export type AxeViolation = {
  id?: unknown;
  impact?: unknown;
  help?: unknown;
  description?: unknown;
  helpUrl?: unknown;
  tags?: unknown;
  nodes?: unknown;
};

function text(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function impactOf(value: unknown): Impact {
  return IMPACTS.includes(value as Impact) ? (value as Impact) : "minor";
}

/**
 * axe tags carry WCAG criteria as `wcag143` (1.4.3) or `wcag2aa`. Only the numbered
 * form identifies a success criterion, and we link to the Understanding document
 * rather than guessing at a slug we cannot derive from the number alone.
 */
export function wcagReferences(tags: unknown, helpUrl: string): WcagReference[] {
  const list = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
  const criteria = new Map<string, WcagReference>();

  for (const tag of list) {
    const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (!match) continue;
    const label = `${match[1]}.${match[2]}.${match[3]}`;
    criteria.set(label, {
      label: `${label} (WCAG)`,
      href: `https://www.w3.org/WAI/WCAG22/quickref/#${encodeURIComponent(`criterion-${label}`)}`,
    });
  }

  // Always keep the axe rule's own help page — it is the most specific link we have.
  // The scheme is re-checked here, not only at the call site: this value becomes an
  // `href`, and `javascript:` must never survive that far.
  const references = [...criteria.values()].sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
  if (/^https?:\/\//i.test(helpUrl)) references.push({ label: "axe rule reference", href: helpUrl });
  return references;
}

function toOccurrence(node: AxeNode): Occurrence | null {
  const target = Array.isArray(node.target) ? node.target.filter((part): part is string => typeof part === "string").join(" ") : "";
  const selector = text(target, MAX_SELECTOR_CHARS);
  if (!selector) return null;

  return {
    selector,
    html: text(node.html, MAX_HTML_CHARS) || "(markup not captured)",
    failure: text(node.failureSummary, MAX_FAILURE_CHARS) || "axe reported this element as failing.",
  };
}

/** Convert axe violations into report findings, most severe first. */
export function normalizeViolations(violations: unknown): FindingInput[] {
  if (!Array.isArray(violations)) return [];

  const findings: FindingInput[] = [];

  for (const raw of violations as AxeViolation[]) {
    const ruleId = text(raw?.id, 80);
    if (!ruleId) continue;

    const nodes = Array.isArray(raw.nodes) ? (raw.nodes as AxeNode[]) : [];
    const occurrences = nodes.slice(0, MAX_OCCURRENCES_STORED).map(toOccurrence).filter((item): item is Occurrence => item !== null);
    // A violation with no usable element evidence is not worth reporting.
    if (occurrences.length === 0) continue;

    const help = text(raw.help, MAX_TITLE_CHARS);
    const description = text(raw.description, MAX_EXPLANATION_CHARS);
    const helpUrl = typeof raw.helpUrl === "string" && /^https?:\/\//i.test(raw.helpUrl) ? raw.helpUrl : "";

    findings.push({
      ruleId,
      kind: classify(raw.tags),
      detector: "axe",
      impact: impactOf(raw.impact),
      title: help || ruleId,
      explanation: description || help || "axe-core reported this rule as failing on the page.",
      wcag: wcagReferences(raw.tags, helpUrl),
      // `count` is the true total; `occurrences` is the bounded sample shown as evidence.
      count: nodes.length,
      occurrences,
    });
  }

  const bySeverity = (a: FindingInput, b: FindingInput) =>
    (IMPACT_ORDER.get(a.impact) ?? 9) - (IMPACT_ORDER.get(b.impact) ?? 9) || b.count - a.count;

  // Violations first and capped independently, so a page full of best-practice
  // notes can never push a real WCAG failure out of the report.
  return [
    ...findings.filter((finding) => finding.kind === "violation").sort(bySeverity).slice(0, MAX_VIOLATION_GROUPS),
    ...findings.filter((finding) => finding.kind === "advisory").sort(bySeverity).slice(0, MAX_ADVISORY_GROUPS),
  ];
}
