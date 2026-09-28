import assert from "node:assert/strict";
import test from "node:test";

// The pure halves of the in-page checks and the viewport passes, bundled from source.
const { keyboardFindings } = await import("../dist/test/scan/keyboard.mjs");
const { reflowFindings, mergeByViewport } = await import("../dist/test/scan/viewport.mjs");
const { formFindings } = await import("../dist/test/scan/forms.mjs");
const { clickableFindings } = await import("../dist/test/scan/interactive.mjs");
const { authFindings } = await import("../dist/test/scan/auth.mjs");
const { imageFindings } = await import("../dist/test/scan/images.mjs");

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

// -------------------------------------------------------------- form checks

const field = (id, note) => ({ selector: `input#${id}`, html: `<input id="${id}">`, note });
const none = () => ({ count: 0, sample: [] });
const found = (...elements) => ({ count: elements.length, sample: elements });

const inspection = (overrides = {}) => ({
  fieldCount: 6,
  invalidWithoutDescription: none(),
  requiredOnlyVisual: none(),
  unlinkedErrors: none(),
  unannouncedForms: none(),
  ...overrides,
});

test("reports nothing when the form checks failed or the forms are clean", () => {
  assert.deepEqual(formFindings(null), []);
  assert.deepEqual(formFindings(inspection()), []);
});

test("an invalid field with no attached error text is a 3.3.1 violation", () => {
  const invalid = byRule(formFindings(inspection({ invalidWithoutDescription: found(field("email")) })), "invalid-field-no-description");

  assert.ok(invalid);
  assert.equal(invalid.kind, "violation");
  assert.equal(invalid.detector, "heuristic");
  assert.equal(invalid.wcag[0].label, "3.3.1 Error Identification");
  assert.equal(invalid.occurrences[0].selector, "input#email");
});

test("an asterisk-only required field is a 1.3.1 violation", () => {
  const required = byRule(formFindings(inspection({ requiredOnlyVisual: found(field("name")) })), "required-not-programmatic");

  assert.ok(required);
  assert.equal(required.kind, "violation");
  assert.equal(required.wcag[0].label, "1.3.1 Info and Relationships");
});

test("unlinked error messages are advisory and quote the message as evidence", () => {
  const unlinked = byRule(formFindings(inspection({ unlinkedErrors: found(field("phone", "Use digits only.")) })), "error-message-not-linked");

  assert.ok(unlinked);
  assert.equal(unlinked.kind, "advisory");
  assert.match(unlinked.occurrences[0].failure, /"Use digits only\."/);
});

test("custom-validated forms without a live region are advisory, not asserted", () => {
  const form = { selector: "form#signup", html: "<form id=\"signup\" novalidate>" };
  const unannounced = byRule(formFindings(inspection({ unannouncedForms: found(form) })), "form-errors-not-announced");

  assert.ok(unannounced);
  assert.equal(unannounced.kind, "advisory");
  assert.equal(unannounced.wcag[0].label, "4.1.3 Status Messages");
  assert.match(unannounced.explanation, /screen reader to confirm/);
});

test("form counts are the true totals, while evidence stays bounded", () => {
  const sample = Array.from({ length: 8 }, (_, index) => field(`f${index}`));
  const invalid = byRule(formFindings(inspection({ invalidWithoutDescription: { count: 31, sample } })), "invalid-field-no-description");

  assert.equal(invalid.count, 31);
  assert.equal(invalid.occurrences.length, 4);
});

// ------------------------------------------------------- fake interactive elements

const control = (id, handler = "click listener") => ({ selector: `div#${id}`, html: `<div id="${id}">Save</div>`, handler });

test("reports nothing when the clickable check failed or found no fake controls", () => {
  assert.deepEqual(clickableFindings(null), []);
  assert.deepEqual(clickableFindings({ candidateCount: 12, fakeControls: { count: 0, sample: [] } }), []);
});

test("a clickable div with no role or tabindex is a keyboard violation naming its handler", () => {
  const [finding] = clickableFindings({ candidateCount: 12, fakeControls: { count: 2, sample: [control("save"), control("close", "React onClick")] } });

  assert.equal(finding.ruleId, "fake-interactive-element");
  assert.equal(finding.kind, "violation");
  assert.equal(finding.detector, "heuristic");
  assert.deepEqual(finding.wcag.map((reference) => reference.label), ["2.1.1 Keyboard", "4.1.2 Name, Role, Value"]);
  assert.equal(finding.count, 2);
  assert.match(finding.occurrences[1].failure, /React onClick/);
});

// ------------------------------------------------------- accessible authentication

const authElement = (selector, note) => ({ selector, html: `<input ${selector}>`, note });
const noAuth = () => ({ count: 0, sample: [] });
const someAuth = (...elements) => ({ count: elements.length, sample: elements });
const signIn = (overrides = {}) => ({
  passwordFields: 1,
  pasteBlocked: noAuth(),
  autocompleteMissing: noAuth(),
  captchas: noAuth(),
  ...overrides,
});

test("sign-in checks report nothing on pages without a password field", () => {
  assert.deepEqual(authFindings(null), []);
  assert.deepEqual(authFindings(signIn({ passwordFields: 0, pasteBlocked: someAuth(authElement("input#pw", "blocked")) })), []);
  assert.deepEqual(authFindings(signIn()), []);
});

test("blocked paste on a password field is a 3.3.8 violation", () => {
  const blocked = byRule(authFindings(signIn({ pasteBlocked: someAuth(authElement("input#pw", "Pasting into this field is cancelled by the page.")) })), "auth-paste-blocked");

  assert.ok(blocked);
  assert.equal(blocked.kind, "violation");
  assert.equal(blocked.wcag[0].label, "3.3.8 Accessible Authentication (Minimum)");
  assert.equal(blocked.occurrences[0].failure, "Pasting into this field is cancelled by the page.");
});

test("missing autocomplete hints and CAPTCHAs are advisories, not asserted failures", () => {
  const findings = authFindings(signIn({
    autocompleteMissing: someAuth(authElement("input#email", "Username field has no autocomplete attribute; expected \"username\".")),
    captchas: someAuth(authElement("div.g-recaptcha", "reCAPTCHA challenge on a sign-in page.")),
  }));

  assert.equal(byRule(findings, "auth-autocomplete-missing").kind, "advisory");
  assert.equal(byRule(findings, "auth-captcha").kind, "advisory");
  assert.equal(byRule(findings, "auth-paste-blocked"), undefined);
});

// ------------------------------------------------------------ placeholder alt text

const image = (alt, src = "https://example.com/assets/team.jpg") => ({
  selector: "img.hero", html: `<img alt="${alt}">`, alt, src, context: "", x: 0, y: 0, width: 400, height: 300,
});
const placeholderFailures = (...images) => imageFindings({ images, samples: [] })[0]?.occurrences.map((occurrence) => occurrence.failure) ?? [];

test("flags file names, camera names, IDs and generic words used as alt text", () => {
  const [finding] = imageFindings({ images: [image("IMG_0042.jpg"), image("DSC01234"), image("48213"), image("logo")], samples: [] });

  assert.equal(finding.ruleId, "alt-text-placeholder");
  assert.equal(finding.kind, "violation");
  assert.equal(finding.wcag[0].label, "1.1.1 Non-text Content");
  assert.equal(finding.count, 4);
  assert.match(finding.occurrences[0].failure, /is a file name/);
  assert.match(finding.occurrences[1].failure, /camera or screenshot file name/);
  assert.match(finding.occurrences[2].failure, /number or ID/);
  assert.match(finding.occurrences[3].failure, /generic word "logo"/);
});

test("flags alt text that repeats a machine-made file name", () => {
  assert.match(placeholderFailures(image("team-photo-2", "https://example.com/team-photo-2.webp?w=800"))[0], /repeats the image's file name/);
});

test("leaves real descriptions alone, including a brand name that matches its file", () => {
  assert.deepEqual(placeholderFailures(
    image("Acme", "https://example.com/acme.png"),
    image("Volunteers planting trees along the river path"),
    image("Photo of the 2024 team offsite"),
  ), []);
  assert.deepEqual(imageFindings(null), []);
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
