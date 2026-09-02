import assert from "node:assert/strict";
import test from "node:test";

// The pure halves of the keyboard walk and the viewport passes, bundled from source.
const { keyboardFindings } = await import("../dist/test/scan/keyboard.mjs");
const { reflowFindings, mergeByViewport } = await import("../dist/test/scan/viewport.mjs");

const step = (index, overrides = {}) => ({
  index,
  selector: `button.control-${index}`,
  html: `<button class="control-${index}">Go</button>`,
  x: 100,
  y: 100 + index * 40,
  visible: true,
  ...overrides,
});

const walk = (overrides = {}) => ({
  steps: [step(0), step(1), step(2)],
  focusableCount: 20,
  withoutIndicator: [],
  stuckAt: null,
  tightCycle: null,
  ...overrides,
});

const byRule = (findings, ruleId) => findings.find((finding) => finding.ruleId === ruleId);

// ------------------------------------------------------------- keyboard walk

test("reports nothing when the walk failed or found no focusable elements", () => {
  assert.deepEqual(keyboardFindings(null), []);
  assert.deepEqual(keyboardFindings(walk({ steps: [] })), []);
});

test("a clean walk produces no findings", () => {
  assert.deepEqual(keyboardFindings(walk()), []);
});

test("focus that stops advancing is a critical keyboard trap", () => {
  const findings = keyboardFindings(walk({ stuckAt: step(2) }));
  const trap = byRule(findings, "keyboard-trap");

  assert.ok(trap, "expected a keyboard-trap finding");
  assert.equal(trap.kind, "violation");
  assert.equal(trap.detector, "heuristic");
  assert.equal(trap.impact, "critical");
  assert.equal(trap.wcag[0].label, "2.1.2 No Keyboard Trap");
  assert.equal(trap.occurrences.length, 1);
});

test("a tight focus cycle is reported as a trap with its members as evidence", () => {
  const cycle = [step(1), step(2), step(3)];
  const trap = byRule(keyboardFindings(walk({ tightCycle: cycle })), "keyboard-trap-cycle");

  assert.ok(trap);
  assert.equal(trap.count, 3);
  assert.equal(trap.occurrences.length, 3);
  assert.match(trap.explanation, /20 focusable elements/);
});

test("focus landing on invisible elements is a violation", () => {
  const findings = keyboardFindings(walk({ steps: [step(0), step(1, { visible: false }), step(2, { visible: false })] }));
  const hidden = byRule(findings, "focus-on-hidden-element");

  assert.ok(hidden);
  assert.equal(hidden.count, 2);
  assert.equal(hidden.kind, "violation");
});

test("missing focus indicators are reported, but only for visible elements", () => {
  // Index 1 is invisible: it is already covered by focus-on-hidden-element, and
  // reporting it twice would double-count one problem.
  const findings = keyboardFindings(walk({
    steps: [step(0), step(1, { visible: false }), step(2)],
    withoutIndicator: [0, 1, 2],
  }));

  const indicator = byRule(findings, "focus-not-visible");
  assert.equal(indicator.count, 2);
  assert.deepEqual(indicator.occurrences.map((o) => o.selector), ["button.control-0", "button.control-2"]);
});

test("tab-order reversals are advisory, not asserted as a failure", () => {
  // Four sharp jumps back up the page.
  const steps = [step(0, { y: 900 }), step(1, { y: 100 }), step(2, { y: 900 }), step(3, { y: 100 }), step(4, { y: 900 }), step(5, { y: 100 })];
  const jumps = byRule(keyboardFindings(walk({ steps })), "focus-order-jumps");

  assert.ok(jumps);
  assert.equal(jumps.kind, "advisory", "a judgement call must not be reported as a WCAG failure");
  assert.equal(jumps.detector, "heuristic");
});

test("a couple of small reversals are not enough to report", () => {
  const steps = [step(0, { y: 500 }), step(1, { y: 100 }), step(2, { y: 520 }), step(3, { y: 560 })];
  assert.equal(byRule(keyboardFindings(walk({ steps })), "focus-order-jumps"), undefined);
});

// ------------------------------------------------------------------- reflow

test("no reflow finding when the page fits its viewport", () => {
  assert.deepEqual(reflowFindings(null), []);
  assert.deepEqual(reflowFindings({ scrollWidth: 320, clientWidth: 320, offenders: [] }), []);
  // A few pixels is scrollbar noise, not a failure.
  assert.deepEqual(reflowFindings({ scrollWidth: 326, clientWidth: 320, offenders: [] }), []);
});

test("horizontal overflow is a 1.4.10 violation naming the widest element", () => {
  const [finding] = reflowFindings({
    scrollWidth: 900,
    clientWidth: 320,
    offenders: [{ selector: "table.pricing", html: "<table class=\"pricing\">", right: 880 }],
  });

  assert.equal(finding.ruleId, "reflow-horizontal-scroll");
  assert.equal(finding.kind, "violation");
  assert.equal(finding.detector, "heuristic");
  assert.equal(finding.wcag[0].label, "1.4.10 Reflow");
  assert.match(finding.explanation, /320 CSS pixels/);
  assert.match(finding.occurrences[0].failure, /880px/);
});

test("still reports overflow when no single element could be blamed", () => {
  const [finding] = reflowFindings({ scrollWidth: 700, clientWidth: 320, offenders: [] });
  assert.equal(finding.occurrences.length, 1);
  assert.equal(finding.occurrences[0].selector, "body");
});

// --------------------------------------------------------- viewport merging

const axeFinding = (ruleId, count, occurrences = 1) => ({
  ruleId,
  kind: "violation",
  detector: "axe",
  impact: "serious",
  title: ruleId,
  explanation: "",
  wcag: [],
  count,
  occurrences: Array.from({ length: occurrences }, (_, i) => ({ selector: `#${ruleId}-${i}`, html: "", failure: "" })),
});

test("labels each finding with the viewports it was seen at", () => {
  const merged = mergeByViewport(
    [axeFinding("color-contrast", 10), axeFinding("label", 2)],
    [axeFinding("color-contrast", 14), axeFinding("target-size", 30)],
  );

  assert.equal(merged.find((f) => f.ruleId === "color-contrast").context, "Desktop and mobile");
  assert.equal(merged.find((f) => f.ruleId === "label").context, "Desktop");
  assert.equal(merged.find((f) => f.ruleId === "target-size").context, "Mobile only");
});

test("a rule seen at both viewports keeps the higher count, never the sum", () => {
  const merged = mergeByViewport([axeFinding("color-contrast", 10)], [axeFinding("color-contrast", 14)]);
  assert.equal(merged.length, 1, "the same rule must not appear twice");
  assert.equal(merged[0].count, 14, "10 and 14 are two measurements of one page, not 24 problems");
});

test("keeps whichever viewport produced richer evidence", () => {
  const merged = mergeByViewport([axeFinding("color-contrast", 10, 1)], [axeFinding("color-contrast", 9, 4)]);
  assert.equal(merged[0].occurrences.length, 4);
});

test("mobile-only findings survive when desktop found nothing", () => {
  const merged = mergeByViewport([], [axeFinding("target-size", 30)]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].context, "Mobile only");
});
