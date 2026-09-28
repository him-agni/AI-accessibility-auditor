/**
 * Keyboard and focus walk — checks axe structurally cannot make.
 *
 * axe reads the DOM; it never presses a key. Whether a keyboard user can actually
 * escape a widget, or can see where they are, is only answerable by driving the
 * browser. This module presses Tab for real and records where focus lands.
 *
 * Everything here is best-effort: a failure returns no findings rather than failing
 * the scan. The axe results are the product's floor and must never be lost because
 * an extra check misbehaved.
 */
import type { FindingInput, Occurrence } from "../fixes/types";

/** Tab presses to make. Above this a page is almost certainly cycling anyway. */
const MAX_TAB_PRESSES = 60;
/** Same element focused this many times in a row means focus is not advancing. */
const STUCK_REPEATS = 3;
/** A cycle shorter than this, on a page with many focusable elements, is a trap. */
const TIGHT_CYCLE_SIZE = 5;
const MIN_FOCUSABLE_FOR_CYCLE_CHECK = 10;
/** Upward jumps larger than this count as a reading-order reversal. */
const REVERSAL_PX = 200;
const MIN_REVERSALS = 3;
const MAX_EVIDENCE = 4;

export type FocusStep = {
  index: number;
  html: string;
  selector: string;
  x: number;
  y: number;
  visible: boolean;
};

export type KeyboardWalk = {
  steps: FocusStep[];
  focusableCount: number;
  /** Indices of steps whose appearance did not change at all when focused. */
  withoutIndicator: number[];
  stuckAt: FocusStep | null;
  tightCycle: FocusStep[] | null;
};

/** Only what this module needs from a puppeteer Page, so the logic stays testable. */
interface WalkablePage {
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
}

/* -- functions below run inside the page; they must not close over anything here -- */

function countFocusable() {
  return document.querySelectorAll(
    'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
  ).length;
}

function resetFocusToTop() {
  document.body.setAttribute("tabindex", "-1");
  document.body.focus();
}

function describeActiveElement(index: number) {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return null;
  el.setAttribute("data-clarity-focus", String(index));
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  let selector = el.tagName.toLowerCase();
  if (el.id) selector += `#${el.id}`;
  else if (el.classList.length) selector += `.${[...el.classList].slice(0, 2).join(".")}`;
  return {
    index,
    html: (el.outerHTML || "").slice(0, 300),
    selector,
    x: rect.x + window.scrollX,
    y: rect.y + window.scrollY,
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.opacity !== "0",
  };
}

/**
 * Compares each visited element's rendered style with and without focus. Runs after
 * the walk, so re-focusing elements cannot disturb the recorded tab order. The
 * parent is sampled too, because `:focus-within` styling is common and legitimate.
 */
function measureFocusIndicators() {
  const snapshot = (el: Element | null) => {
    if (!el) return "";
    const s = getComputedStyle(el);
    return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset, s.boxShadow,
      s.border, s.backgroundColor, s.color, s.textDecorationLine, s.filter].join("|");
  };

  const missing: number[] = [];
  for (const el of document.querySelectorAll("[data-clarity-focus]")) {
    const parent = el.parentElement;
    const before = `${snapshot(el)}::${snapshot(parent)}`;
    try { (el as HTMLElement).focus({ preventScroll: true }); } catch { continue; }
    const after = `${snapshot(el)}::${snapshot(parent)}`;
    try { (el as HTMLElement).blur(); } catch { /* no longer focusable */ }
    if (before === after) missing.push(Number(el.getAttribute("data-clarity-focus")));
  }
  return missing;
}

const positionKey = (step: FocusStep) => `${step.selector}@${Math.round(step.x)},${Math.round(step.y)}`;

type TabResult = Pick<KeyboardWalk, "steps" | "stuckAt" | "tightCycle">;

/**
 * Press Tab until focus stops advancing, returns to an element already visited,
 * or the press budget runs out.
 */
async function tabThroughPage(page: WalkablePage, focusableCount: number): Promise<TabResult> {
  const steps: FocusStep[] = [];
  const seen = new Map<string, number>();
  let repeats = 0;

  for (let index = 0; index < Math.min(MAX_TAB_PRESSES, focusableCount + 5); index += 1) {
    await page.keyboard.press("Tab");
    const step = await page.evaluate(describeActiveElement, index);
    if (!step) continue;

    const key = positionKey(step);
    const previous = steps[steps.length - 1];

    // Focus that will not advance is an unambiguous trap.
    if (previous && positionKey(previous) === key) {
      repeats += 1;
      if (repeats >= STUCK_REPEATS - 1) return { steps, stuckAt: step, tightCycle: null };
      continue;
    }
    repeats = 0;

    // Revisiting an element after only a handful of stops, on a page with plenty
    // of controls, means focus is circling inside something it cannot leave.
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      const cycle = steps.slice(firstSeen);
      const isTrap = cycle.length < TIGHT_CYCLE_SIZE && focusableCount >= MIN_FOCUSABLE_FOR_CYCLE_CHECK;
      return { steps, stuckAt: null, tightCycle: isTrap ? cycle : null };
    }

    seen.set(key, steps.length);
    steps.push(step);
  }

  return { steps, stuckAt: null, tightCycle: null };
}

/** Drive Tab through the page and record where focus lands. Never throws. */
export async function walkFocusOrder(page: WalkablePage): Promise<KeyboardWalk | null> {
  try {
    const focusableCount = await page.evaluate(countFocusable);
    await page.evaluate(resetFocusToTop);
    const walk = await tabThroughPage(page, focusableCount);
    const withoutIndicator = walk.steps.length > 0 ? await page.evaluate(measureFocusIndicators) : [];
    return { ...walk, focusableCount, withoutIndicator };
  } catch {
    return null;
  }
}

const wcag = (label: string, id: string) => [{ label, href: `https://www.w3.org/WAI/WCAG22/Understanding/${id}.html` }];

const occurrence = (step: FocusStep, note: string): Occurrence => ({
  selector: step.selector,
  html: step.html || "(markup not captured)",
  failure: note,
});

type HeuristicFinding = Omit<FindingInput, "detector" | "count" | "occurrences"> & {
  /** Every step involved. The count is its length; only the first few become evidence. */
  evidence: FocusStep[];
  /** What each evidence element did wrong. */
  note: string;
};

function heuristic({ evidence, note, ...finding }: HeuristicFinding): FindingInput {
  return {
    ...finding,
    detector: "heuristic",
    count: evidence.length,
    occurrences: evidence.slice(0, MAX_EVIDENCE).map((step) => occurrence(step, note)),
  };
}

/** Turn a walk into report findings. All carry `detector: "heuristic"`. */
export function keyboardFindings(walk: KeyboardWalk | null): FindingInput[] {
  if (!walk || walk.steps.length === 0) return [];
  const findings: FindingInput[] = [];
  const { steps, withoutIndicator, stuckAt, tightCycle } = walk;

  if (stuckAt) {
    findings.push(heuristic({
      ruleId: "keyboard-trap",
      kind: "violation",
      impact: "critical",
      title: "Keyboard focus cannot move past an element",
      explanation: "Pressing Tab repeatedly left focus on the same element. A keyboard-only user who reaches this point cannot continue through the page, and cannot leave without closing the tab.",
      wcag: wcag("2.1.2 No Keyboard Trap", "no-keyboard-trap"),
      evidence: [stuckAt],
      note: `Focus stayed on this element across ${STUCK_REPEATS} consecutive Tab presses.`,
    }));
  }

  if (tightCycle && tightCycle.length > 0) {
    findings.push(heuristic({
      ruleId: "keyboard-trap-cycle",
      kind: "violation",
      impact: "critical",
      title: "Keyboard focus is cycling inside a small group of elements",
      explanation: `Focus returned to an earlier element after only ${tightCycle.length} stops, on a page with ${walk.focusableCount} focusable elements. This usually means a dialog or menu is holding focus without offering a way out.`,
      wcag: wcag("2.1.2 No Keyboard Trap", "no-keyboard-trap"),
      evidence: tightCycle,
      note: "Focus repeatedly returns to this element.",
    }));
  }

  const hidden = steps.filter((step) => !step.visible);
  if (hidden.length > 0) {
    findings.push(heuristic({
      ruleId: "focus-on-hidden-element",
      kind: "violation",
      impact: "serious",
      title: "Keyboard focus lands on elements that cannot be seen",
      explanation: "These elements receive keyboard focus but render with no size, or are hidden by visibility or opacity. A sighted keyboard user watches focus disappear with no way to tell where it went.",
      wcag: wcag("2.4.3 Focus Order", "focus-order"),
      evidence: hidden,
      note: "This element received focus while not visible.",
    }));
  }

  const unmarked = steps.filter((step) => step.visible && withoutIndicator.includes(step.index));
  if (unmarked.length > 0) {
    findings.push(heuristic({
      ruleId: "focus-not-visible",
      kind: "violation",
      impact: "serious",
      title: "Focused elements show no visible focus indicator",
      explanation: "Focusing these elements changed nothing about how they are drawn — no outline, shadow, border, or colour change on the element or its parent. A keyboard user cannot tell where they are on the page.",
      wcag: wcag("2.4.7 Focus Visible", "focus-visible"),
      evidence: unmarked,
      note: "No style change was detected when this element received focus.",
    }));
  }

  // Reading-order reversals are a judgement call, not a measurable failure, so this
  // is reported as advice rather than asserted as a WCAG violation.
  const reversals = steps.filter((step, index) => index > 0 && steps[index - 1].y - step.y > REVERSAL_PX);
  if (reversals.length >= MIN_REVERSALS) {
    findings.push(heuristic({
      ruleId: "focus-order-jumps",
      kind: "advisory",
      impact: "moderate",
      title: "Tab order jumps around the page",
      explanation: `Focus moved sharply back up the page ${reversals.length} times while tabbing. Tab order follows the DOM, so this often means the visual layout no longer matches the source order. Confirm the sequence still makes sense to someone who cannot see the layout.`,
      wcag: wcag("2.4.3 Focus Order", "focus-order"),
      evidence: reversals,
      note: "Focus jumped upward to this element from lower on the page.",
    }));
  }

  return findings;
}
