import assert from "node:assert/strict";
import test from "node:test";

// The axe -> report mapping, bundled from source by `npm run test:build`.
const { normalizeViolations, wcagReferences, classify } = await import("../dist/test/scan/normalize.mjs");

const node = (overrides = {}) => ({
  target: [".site-header > button.cart-toggle"],
  html: "<button class=\"cart-toggle\"><span class=\"cart-icon\"></span></button>",
  failureSummary: "Fix any of the following: Element does not have an accessible name.",
  ...overrides,
});

const violation = (overrides = {}) => ({
  id: "button-name",
  impact: "critical",
  help: "Buttons must have discernible text",
  description: "Ensures buttons have discernible text",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.13/button-name",
  tags: ["cat.name-role-value", "wcag2a", "wcag412"],
  nodes: [node()],
  ...overrides,
});

test("maps an axe violation onto the report shape", () => {
  const [finding] = normalizeViolations([violation()]);

  assert.equal(finding.ruleId, "button-name");
  assert.equal(finding.impact, "critical");
  assert.equal(finding.title, "Buttons must have discernible text");
  assert.equal(finding.explanation, "Ensures buttons have discernible text");
  assert.equal(finding.count, 1);
  assert.equal(finding.occurrences[0].selector, ".site-header > button.cart-toggle");
  assert.match(finding.occurrences[0].failure, /accessible name/);
});

test("derives WCAG criteria from axe tags and keeps the rule reference", () => {
  const references = wcagReferences(["cat.color", "wcag2aa", "wcag143", "wcag111"], "https://example.com/rule");

  // wcag2aa is a level tag, not a criterion, so it must not become a link.
  assert.deepEqual(references.map((item) => item.label), ["1.1.1 (WCAG)", "1.4.3 (WCAG)", "axe rule reference"]);
  assert.match(references[0].href, /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/quickref\/#/);
  assert.equal(references[2].href, "https://example.com/rule");
});

test("drops a non-http helpUrl rather than linking it", () => {
  const references = wcagReferences(["wcag111"], "javascript:alert(1)");
  assert.deepEqual(references.map((item) => item.label), ["1.1.1 (WCAG)"]);

  const [finding] = normalizeViolations([violation({ helpUrl: "javascript:alert(1)" })]);
  assert.ok(finding.wcag.every((item) => item.href.startsWith("https://")));
});

test("counts every affected element but stores only a bounded sample", () => {
  const nodes = Array.from({ length: 40 }, (_, index) => node({ target: [`#item-${index}`] }));
  const [finding] = normalizeViolations([violation({ nodes })]);

  assert.equal(finding.count, 40, "the report must state the true total");
  assert.equal(finding.occurrences.length, 5, "evidence is capped");
});

test("truncates oversized markup so a hostile page cannot bloat a report", () => {
  const nodes = [node({ html: "<div>".repeat(5000), failureSummary: "x".repeat(5000), target: ["a".repeat(5000)] })];
  const [finding] = normalizeViolations([violation({ nodes })]);
  const [occurrence] = finding.occurrences;

  assert.ok(occurrence.html.length <= 400, `html was ${occurrence.html.length}`);
  assert.ok(occurrence.failure.length <= 400, `failure was ${occurrence.failure.length}`);
  assert.ok(occurrence.selector.length <= 200, `selector was ${occurrence.selector.length}`);
});

test("orders findings by impact, then by how many elements are affected", () => {
  const findings = normalizeViolations([
    violation({ id: "minor-rule", impact: "minor", nodes: [node()] }),
    violation({ id: "serious-few", impact: "serious", nodes: [node()] }),
    violation({ id: "critical-rule", impact: "critical", nodes: [node()] }),
    violation({ id: "serious-many", impact: "serious", nodes: [node(), node(), node()] }),
    violation({ id: "moderate-rule", impact: "moderate", nodes: [node()] }),
  ]);

  assert.deepEqual(findings.map((finding) => finding.ruleId), [
    "critical-rule",
    "serious-many",
    "serious-few",
    "moderate-rule",
    "minor-rule",
  ]);
});

test("survives malformed axe output instead of throwing", () => {
  assert.deepEqual(normalizeViolations(null), []);
  assert.deepEqual(normalizeViolations("nope"), []);
  assert.deepEqual(normalizeViolations([]), []);

  // No id, no usable evidence, and a junk impact: the first two are dropped,
  // the third is kept with impact coerced to the safest value.
  const findings = normalizeViolations([
    { impact: "critical", nodes: [node()] },
    violation({ id: "no-evidence", nodes: [{ target: [], html: "" }] }),
    violation({ id: "junk-impact", impact: "catastrophic" }),
  ]);

  assert.deepEqual(findings.map((finding) => finding.ruleId), ["junk-impact"]);
  assert.equal(findings[0].impact, "minor");
});

test("falls back to readable text when axe omits optional fields", () => {
  const [finding] = normalizeViolations([{ id: "sparse-rule", nodes: [{ target: ["#el"] }] }]);

  assert.equal(finding.title, "sparse-rule");
  assert.ok(finding.explanation.length > 0);
  assert.equal(finding.occurrences[0].html, "(markup not captured)");
  assert.match(finding.occurrences[0].failure, /axe reported/);
});

test("caps the number of rule groups a single page can produce", () => {
  const many = Array.from({ length: 60 }, (_, index) => violation({ id: `rule-${index}`, impact: "serious" }));
  assert.equal(normalizeViolations(many).length, 25);
});

// ------------------------------------------------- violation vs advisory tier

test("classifies a rule by whether it maps to a WCAG success criterion", () => {
  assert.equal(classify(["cat.name-role-value", "wcag2a", "wcag412"]), "violation");
  assert.equal(classify(["wcag21aa", "wcag143"]), "violation");
  assert.equal(classify(["wcag22aa", "wcag258"]), "violation");
  assert.equal(classify(["cat.semantics", "best-practice"]), "advisory");
  // AAA is outside what the product claims to check, so it is not a violation here.
  assert.equal(classify(["wcag2aaa"]), "advisory");
  assert.equal(classify([]), "advisory");
  assert.equal(classify(undefined), "advisory");
});

test("tags each finding with its kind and detector", () => {
  const findings = normalizeViolations([
    violation({ id: "button-name", tags: ["wcag2a", "wcag412"] }),
    violation({ id: "heading-order", tags: ["cat.semantics", "best-practice"] }),
  ]);

  assert.equal(findings.find((f) => f.ruleId === "button-name").kind, "violation");
  assert.equal(findings.find((f) => f.ruleId === "heading-order").kind, "advisory");
  assert.ok(findings.every((f) => f.detector === "axe"), "everything here came from axe");
});

test("orders every violation ahead of every advisory, whatever their impact", () => {
  const findings = normalizeViolations([
    violation({ id: "critical-advice", impact: "critical", tags: ["best-practice"] }),
    violation({ id: "minor-failure", impact: "minor", tags: ["wcag2a"] }),
  ]);

  assert.deepEqual(findings.map((f) => f.ruleId), ["minor-failure", "critical-advice"]);
});

test("caps advisories separately so they cannot crowd out real failures", () => {
  const findings = normalizeViolations([
    ...Array.from({ length: 40 }, (_, i) => violation({ id: `advice-${i}`, tags: ["best-practice"] })),
    ...Array.from({ length: 40 }, (_, i) => violation({ id: `fail-${i}`, tags: ["wcag2a"] })),
  ]);

  assert.equal(findings.filter((f) => f.kind === "violation").length, 25);
  assert.equal(findings.filter((f) => f.kind === "advisory").length, 15);
});
