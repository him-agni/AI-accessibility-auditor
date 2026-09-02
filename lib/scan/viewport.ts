/**
 * Multi-viewport checks.
 *
 * A desktop-only scan misses a whole class of real problems: touch targets that are
 * fine at 1440px and cramped at 390px, and layouts that force horizontal scrolling
 * when narrowed. Both are answerable only by resizing and looking again.
 *
 * Like the keyboard walk, everything here is best-effort — the desktop axe results
 * are the floor and must survive any failure in this module.
 */
import type { FindingInput, Occurrence } from "../fixes/types";

export const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

/**
 * WCAG 2.2 SC 1.4.10 Reflow asks that content not require scrolling in two
 * directions at 320 CSS px wide — the width a 1280px viewport reaches at 400% zoom.
 */
export const REFLOW_WIDTH = 320;
/** Scrollbars and rounding mean a few px of overflow is noise, not a failure. */
const REFLOW_TOLERANCE_PX = 8;
const MAX_EVIDENCE = 4;

export type ReflowResult = {
  scrollWidth: number;
  clientWidth: number;
  offenders: { selector: string; html: string; right: number }[];
};

interface ResizablePage {
  evaluate<T>(fn: () => T): Promise<T>;
  setViewport(viewport: { width: number; height: number }): Promise<void>;
}

/* -- runs inside the page -- */

function measureReflow() {
  const doc = document.documentElement;
  const clientWidth = doc.clientWidth;

  // Find the elements actually sticking out, so the report can name them.
  const offenders: { selector: string; html: string; right: number }[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const right = rect.right + window.scrollX;
    if (right <= clientWidth + 8) continue;
    // Only report the outermost offender in any branch; children inherit the overflow.
    if (offenders.some((seen) => el.closest(seen.selector) !== null)) continue;

    let selector = el.tagName.toLowerCase();
    if (el.id) selector += `#${el.id}`;
    else if (el.classList.length) selector += `.${[...el.classList].slice(0, 2).join(".")}`;
    offenders.push({ selector, html: (el.outerHTML || "").slice(0, 300), right: Math.round(right) });
    if (offenders.length >= 8) break;
  }

  return { scrollWidth: doc.scrollWidth, clientWidth, offenders };
}

/** Narrow the page and measure horizontal overflow. Returns null on any failure. */
export async function measureReflowAt(page: ResizablePage, width = REFLOW_WIDTH): Promise<ReflowResult | null> {
  try {
    await page.setViewport({ width, height: 800 });
    // Let responsive layout and media queries settle before measuring.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    return await page.evaluate(measureReflow);
  } catch {
    return null;
  }
}

export function reflowFindings(result: ReflowResult | null): FindingInput[] {
  if (!result) return [];
  const overflow = result.scrollWidth - result.clientWidth;
  if (overflow <= REFLOW_TOLERANCE_PX) return [];

  const occurrences: Occurrence[] = result.offenders.slice(0, MAX_EVIDENCE).map((offender) => ({
    selector: offender.selector,
    html: offender.html || "(markup not captured)",
    failure: `This element extends to ${offender.right}px, past the ${result.clientWidth}px viewport.`,
  }));

  return [{
    ruleId: "reflow-horizontal-scroll",
    kind: "violation",
    detector: "heuristic",
    impact: "serious",
    title: "Content requires horizontal scrolling on a narrow screen",
    explanation: `At ${result.clientWidth} CSS pixels wide the page scrolls ${overflow}px horizontally. Someone using a small screen, or zoomed to 400%, has to scroll sideways to read every line — which WCAG 1.4.10 Reflow exists to prevent.`,
    wcag: [{ label: "1.4.10 Reflow", href: "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html" }],
    count: Math.max(1, result.offenders.length),
    occurrences: occurrences.length > 0
      ? occurrences
      : [{ selector: "body", html: "(no single element identified)", failure: `The document scrolls to ${result.scrollWidth}px inside a ${result.clientWidth}px viewport.` }],
  }];
}

/**
 * Merge a second viewport's axe findings into the first's, recording where each rule
 * was seen. Rules found at both keep the higher element count, because that is the
 * larger of two true measurements rather than a sum of overlapping ones.
 */
export function mergeByViewport(desktop: FindingInput[], mobile: FindingInput[]): FindingInput[] {
  const merged = new Map<string, FindingInput>();

  for (const finding of desktop) merged.set(finding.ruleId, { ...finding, context: "Desktop" });

  for (const finding of mobile) {
    const existing = merged.get(finding.ruleId);
    if (!existing) {
      merged.set(finding.ruleId, { ...finding, context: "Mobile only" });
      continue;
    }
    merged.set(finding.ruleId, {
      ...existing,
      context: "Desktop and mobile",
      count: Math.max(existing.count, finding.count),
      // Prefer whichever viewport produced richer evidence.
      occurrences: finding.occurrences.length > existing.occurrences.length ? finding.occurrences : existing.occurrences,
    });
  }

  return [...merged.values()];
}
