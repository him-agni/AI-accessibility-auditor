/** Provider-neutral entry point for fix generation. */
import { deterministicFix } from "./deterministic";
import { createGeminiFixProvider, DEFAULT_GEMINI_MODEL } from "./gemini";
import type { Finding, FindingInput, FixProvider, FixSuggestion } from "./types";

export type FixProviderEnv = { GEMINI_API_KEY?: string; GEMINI_MODEL?: string };

/**
 * Returns the configured model provider, or null when none is available.
 * Absence is a supported state, not an error: the report still ships with
 * deterministic guidance.
 */
export function createFixProvider(env: FixProviderEnv, onError?: (message: string) => void): FixProvider | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return createGeminiFixProvider({ apiKey, model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL, onError });
}

/** Attach exactly one remediation per rule group, falling back per group. */
export function applyFixes(findings: FindingInput[], generated: Map<string, FixSuggestion>): Finding[] {
  return findings.map((finding) => ({ ...finding, fix: generated.get(finding.ruleId) ?? deterministicFix(finding) }));
}

/** Generate remediations for a whole audit. Never throws — a failed model call degrades to deterministic guidance. */
export async function buildFindings(findings: FindingInput[], env: FixProviderEnv, onError?: (message: string) => void): Promise<Finding[]> {
  const provider = createFixProvider(env, onError);
  if (!provider) return applyFixes(findings, new Map());

  try {
    return applyFixes(findings, await provider.generate(findings));
  } catch {
    onError?.("fix provider threw");
    return applyFixes(findings, new Map());
  }
}

export { deterministicFix } from "./deterministic";
export { DEFAULT_GEMINI_MODEL } from "./gemini";
export type { Confidence, Finding, FindingInput, FixProvider, FixSuggestion, Impact, Occurrence, WcagReference } from "./types";
