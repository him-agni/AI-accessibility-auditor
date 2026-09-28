/**
 * Static form checks — how validation errors and required state reach assistive
 * technology.
 *
 * axe checks that a field has a label. It does not check whether an error shown
 * next to the field is attached to it, and it reports a broken `aria-describedby`
 * only as "needs review", which this scanner never collects.
 *
 * This only reads the DOM. Forms on third-party sites are never submitted or
 * typed into: that can create accounts, send messages, or trigger purchases on
 * pages we do not own. It runs after the keyboard walk, so errors that fields
 * show on blur are visible; errors that only appear after a submit are out of
 * reach, and the findings say so.
 *
 * Best-effort, like the keyboard walk: a failure returns no findings.
 */
import type { FindingInput, Occurrence } from "../fixes/types";

const MAX_EVIDENCE = 4;

export type FormElement = { selector: string; html: string; note?: string };

/** A true total alongside a bounded sample, so the report count is never capped. */
export type Sampled = { count: number; sample: FormElement[] };

export type FormInspection = {
  fieldCount: number;
  /** `aria-invalid="true"` with no `aria-describedby` text saying what is wrong. */
  invalidWithoutDescription: Sampled;
  /** Label shows an asterisk, but the field is not required programmatically. */
  requiredOnlyVisual: Sampled;
  /** Visible error-looking text beside a field that does not reference it. */
  unlinkedErrors: Sampled;
  /** `novalidate` forms on a page with no live region to announce errors. */
  unannouncedForms: Sampled;
};

interface InspectablePage {
  evaluate<T>(fn: () => T): Promise<T>;
}

/* -- runs inside the page; it must not close over anything in this module -- */

function inspectForms(): FormInspection {
  const SAMPLE_SIZE = 8;
  const FIELDS = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
    "select", "textarea",
    '[role="textbox"]', '[role="combobox"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="spinbutton"]',
  ].join(", ");
  const ERROR_CANDIDATES = '[role="alert"], [class*="error" i], [class*="invalid" i], [id*="error" i]';
  const LIVE_REGIONS = '[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"], [role="log"], output';
  const CONSTRAINED = '[required], [aria-required="true"], [pattern], [minlength], [maxlength], [min], [max], input[type="email"], input[type="url"], input[type="number"]';

  const textOf = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();

  const isShown = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.opacity !== "0";
  };

  const describe = (el: Element, note?: string): FormElement => {
    let selector = el.tagName.toLowerCase();
    if (el.id) selector += `#${el.id}`;
    else if (el.classList.length) selector += `.${[...el.classList].slice(0, 2).join(".")}`;
    return { selector, html: (el.outerHTML || "").slice(0, 300), note };
  };

  const sampled = (items: FormElement[]) => ({ count: items.length, sample: items.slice(0, SAMPLE_SIZE) });

  const idrefs = (el: Element, attribute: string) =>
    (el.getAttribute(attribute) || "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((target): target is HTMLElement => target !== null);

  const labelsOf = (field: Element) => [...((field as HTMLInputElement).labels ?? []), ...idrefs(field, "aria-labelledby")];

  const fields = [...document.querySelectorAll(FIELDS)].filter(isShown);

  const invalidWithoutDescription = fields.filter((field) =>
    field.getAttribute("aria-invalid") === "true"
    // aria-errormessage is axe's to judge; it checks that reference thoroughly.
    && !field.hasAttribute("aria-errormessage")
    && idrefs(field, "aria-describedby").every((target) => textOf(target) === ""));

  const requiredOnlyVisual = fields.filter((field) => {
    const labelText = labelsOf(field).map(textOf).join(" ");
    const markedRequired = field.hasAttribute("required") || field.getAttribute("aria-required") === "true";
    // Visually hidden "(required)" text inside the label already tells a screen reader.
    return labelText.includes("*") && !/required/i.test(labelText) && !markedRequired;
  });

  // An error message belongs to a field when they share a small container that
  // holds only that one field. Wrappers such as `.has-error` contain the field
  // itself, so they are not messages.
  const fieldFor = (message: Element) => {
    let container = message.parentElement;
    for (let depth = 0; container && depth < 3; depth += 1, container = container.parentElement) {
      const inside = fields.filter((field) => container!.contains(field));
      if (inside.length === 1) return inside[0];
      if (inside.length > 1) return null;
    }
    return null;
  };

  const isAttached = (message: Element, field: Element) =>
    [...idrefs(field, "aria-describedby"), ...idrefs(field, "aria-errormessage"), ...labelsOf(field)]
      .some((target) => target.contains(message) || message.contains(target));

  const unlinkedErrors: FormElement[] = [];
  const reported = new Set<Element>();
  for (const message of document.querySelectorAll(ERROR_CANDIDATES)) {
    const text = textOf(message);
    if (!text || text.length > 300 || !isShown(message) || message.querySelector(FIELDS)) continue;
    const field = fieldFor(message);
    if (!field || reported.has(field) || isAttached(message, field)) continue;
    reported.add(field);
    unlinkedErrors.push(describe(field, text.slice(0, 120)));
  }

  // novalidate means the author replaced the browser's own error bubbles. With no
  // live region anywhere, errors appearing later are announced only if focus moves.
  const hasLiveRegion = document.querySelector(LIVE_REGIONS) !== null;
  const unannouncedForms = hasLiveRegion ? [] : [...document.querySelectorAll("form")].filter((form) =>
    form.noValidate && form.querySelector(CONSTRAINED) !== null && fields.some((field) => form.contains(field)));

  return {
    fieldCount: fields.length,
    invalidWithoutDescription: sampled(invalidWithoutDescription.map((field) => describe(field))),
    requiredOnlyVisual: sampled(requiredOnlyVisual.map((field) => describe(field))),
    unlinkedErrors: sampled(unlinkedErrors),
    unannouncedForms: sampled(unannouncedForms.map((form) => describe(form))),
  };
}

/** Read the page's forms as loaded. Returns null on any failure. */
export async function checkForms(page: InspectablePage): Promise<FormInspection | null> {
  try {
    return await page.evaluate(inspectForms);
  } catch {
    return null;
  }
}

const wcag = (label: string, id: string) => [{ label, href: `https://www.w3.org/WAI/WCAG22/Understanding/${id}.html` }];

type FormFinding = Omit<FindingInput, "detector" | "count" | "occurrences"> & {
  found: Sampled;
  /** What each evidence element did wrong, given its captured note if any. */
  failure: (element: FormElement) => string;
};

function heuristic({ found, failure, ...finding }: FormFinding): FindingInput {
  return {
    ...finding,
    detector: "heuristic",
    count: found.count,
    occurrences: found.sample.slice(0, MAX_EVIDENCE).map((element): Occurrence => ({
      selector: element.selector,
      html: element.html || "(markup not captured)",
      failure: failure(element),
    })),
  };
}

/** Turn a form inspection into report findings. All carry `detector: "heuristic"`. */
export function formFindings(result: FormInspection | null): FindingInput[] {
  if (!result) return [];
  const findings: FindingInput[] = [];

  if (result.invalidWithoutDescription.count > 0) {
    findings.push(heuristic({
      ruleId: "invalid-field-no-description",
      kind: "violation",
      impact: "serious",
      title: "Fields marked invalid have no error text attached",
      explanation: "These fields carry aria-invalid=\"true\", so a screen reader announces them as invalid — but no aria-describedby text says what is wrong. An error may be shown on screen, yet someone filling in the form by ear hears only \"invalid\", with no reason and no way to fix it.",
      wcag: wcag("3.3.1 Error Identification", "error-identification"),
      found: result.invalidWithoutDescription,
      failure: () => "Marked aria-invalid=\"true\", but aria-describedby points at no error text.",
    }));
  }

  if (result.requiredOnlyVisual.count > 0) {
    findings.push(heuristic({
      ruleId: "required-not-programmatic",
      kind: "violation",
      impact: "moderate",
      title: "Required fields are marked only with an asterisk",
      explanation: "The label shows an asterisk, but the field has neither the required attribute nor aria-required=\"true\". Sighted users see that the field is mandatory; screen reader users are not told until the form rejects their submission.",
      wcag: wcag("1.3.1 Info and Relationships", "info-and-relationships"),
      found: result.requiredOnlyVisual,
      failure: () => "The label shows an asterisk, but the field is not marked required.",
    }));
  }

  // Found by class name and position, so this is a strong hint rather than a
  // measurement — the same honesty call as focus-order-jumps.
  if (result.unlinkedErrors.count > 0) {
    findings.push(heuristic({
      ruleId: "error-message-not-linked",
      kind: "advisory",
      impact: "moderate",
      title: "Error messages are not connected to their fields",
      explanation: "Text that looks like a validation error sits beside these fields, but the field does not reference it through aria-describedby. A screen reader user moving between fields hears the field and not the message, so the error is easy to miss entirely.",
      wcag: wcag("3.3.1 Error Identification", "error-identification"),
      found: result.unlinkedErrors,
      failure: (element) => `The nearby message "${element.note ?? ""}" is not referenced by this field.`,
    }));
  }

  // Only a submit would show whether focus moves to the errors, and the scan never
  // submits. Advisory, with the manual test spelled out.
  if (result.unannouncedForms.count > 0) {
    findings.push(heuristic({
      ruleId: "form-errors-not-announced",
      kind: "advisory",
      impact: "moderate",
      title: "Custom-validated forms have no way to announce errors",
      explanation: "These forms set novalidate, so the browser's own error messages are switched off, and the page contains no aria-live, role=\"alert\", or role=\"status\" region. Errors that appear after submitting are announced only if focus is moved to them. Submit the form with a mistake while using a screen reader to confirm.",
      wcag: wcag("4.1.3 Status Messages", "status-messages"),
      found: result.unannouncedForms,
      failure: () => "This form sets novalidate, and the page has no live region for its errors.",
    }));
  }

  return findings;
}
