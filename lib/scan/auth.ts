/**
 * Accessible authentication — WCAG 2.2 SC 3.3.8 (Minimum), AA.
 *
 * Signing in must not depend on remembering or transcribing something unless a
 * mechanism helps, and password managers and copy-paste are that mechanism.
 * These checks run only on pages with a visible password field.
 *
 * One check dispatches a synthetic, empty paste event at each password field and
 * sees whether the page cancels it. Nothing is typed, the field's value never
 * changes, and nothing is submitted.
 *
 * Best-effort: a failure returns no findings.
 */
import type { FindingInput, Occurrence } from "../fixes/types";

const MAX_EVIDENCE = 4;

export type AuthElement = { selector: string; html: string; note: string };
type Sampled = { count: number; sample: AuthElement[] };

export type AuthInspection = {
  passwordFields: number;
  pasteBlocked: Sampled;
  autocompleteMissing: Sampled;
  captchas: Sampled;
};

interface InspectablePage {
  evaluate<T>(fn: () => T): Promise<T>;
}

/* -- runs inside the page; it must not close over anything in this module -- */

function inspectAuthentication(): AuthInspection {
  const SAMPLE_SIZE = 8;
  const USERNAME_TYPES = ["text", "email", "tel", ""];
  const CAPTCHAS: [string, string][] = [
    ['iframe[src*="recaptcha"], .g-recaptcha', "reCAPTCHA"],
    ['iframe[src*="hcaptcha"], .h-captcha', "hCaptcha"],
    ['iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]', "Arkose / FunCaptcha"],
    ['img[src*="captcha" i], img[alt*="captcha" i], input[name*="captcha" i], [id*="captcha" i]', "an image or text CAPTCHA"],
  ];

  const isShown = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.opacity !== "0";
  };

  const describe = (el: Element, note: string): AuthElement => {
    let selector = el.tagName.toLowerCase();
    if (el.id) selector += `#${el.id}`;
    else if (el.classList.length) selector += `.${[...el.classList].slice(0, 2).join(".")}`;
    return { selector, html: (el.outerHTML || "").slice(0, 300), note };
  };

  const sampled = (items: AuthElement[]) => ({ count: items.length, sample: items.slice(0, SAMPLE_SIZE) });
  const tokens = (el: Element) => (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).filter(Boolean);
  const shownAutocomplete = (el: Element) => el.getAttribute("autocomplete") === null ? "no autocomplete attribute" : `autocomplete="${el.getAttribute("autocomplete")}"`;

  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(isShown);
  if (passwords.length === 0) return { passwordFields: 0, pasteBlocked: sampled([]), autocompleteMissing: sampled([]), captchas: sampled([]) };

  const pasteBlocked = passwords.filter((field) => {
    try {
      const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      field.dispatchEvent(paste);
      return paste.defaultPrevented;
    } catch {
      return false;
    }
  }).map((field) => describe(field, "Pasting into this field is cancelled by the page."));

  const autocompleteMissing: AuthElement[] = [];
  for (const field of passwords) {
    const values = tokens(field);
    if (!values.includes("current-password") && !values.includes("new-password")) {
      autocompleteMissing.push(describe(field, `Password field has ${shownAutocomplete(field)}; expected "current-password" or "new-password".`));
    }
  }

  // The username is the last visible text-like field before the first password
  // field in the same form — the pairing password managers themselves look for.
  const firstPassword = passwords[0];
  const scope = firstPassword.closest("form") ?? document;
  const before = [...scope.querySelectorAll("input")].filter((input) =>
    USERNAME_TYPES.includes(input.getAttribute("type")?.toLowerCase() ?? "")
    && isShown(input)
    && (input.compareDocumentPosition(firstPassword) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const username = before[before.length - 1];
  if (username) {
    const values = tokens(username);
    if (!values.includes("username") && !values.includes("email")) {
      autocompleteMissing.push(describe(username, `Username field has ${shownAutocomplete(username)}; expected "username".`));
    }
  }

  // One CAPTCHA per page, most specific vendor first. reCAPTCHA v3 shows only a
  // badge and never a challenge; Cloudflare Turnstile is passive. Neither is listed.
  const captchas: AuthElement[] = [];
  for (const [selector, vendor] of CAPTCHAS) {
    const found = [...document.querySelectorAll(selector)].find((el) => isShown(el) && !el.closest(".grecaptcha-badge"));
    if (!found) continue;
    captchas.push(describe(found, `${vendor} challenge on a sign-in page.`));
    break;
  }

  return {
    passwordFields: passwords.length,
    pasteBlocked: sampled(pasteBlocked),
    autocompleteMissing: sampled(autocompleteMissing),
    captchas: sampled(captchas),
  };
}

/** Inspect a page's sign-in form, if it has one. Returns null on any failure. */
export async function checkAuthentication(page: InspectablePage): Promise<AuthInspection | null> {
  try {
    return await page.evaluate(inspectAuthentication);
  } catch {
    return null;
  }
}

const SC_3_3_8 = [{ label: "3.3.8 Accessible Authentication (Minimum)", href: "https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html" }];

function evidence(found: Sampled): Occurrence[] {
  return found.sample.slice(0, MAX_EVIDENCE).map((element) => ({
    selector: element.selector,
    html: element.html || "(markup not captured)",
    failure: element.note,
  }));
}

/** Turn a sign-in inspection into report findings. All carry `detector: "heuristic"`. */
export function authFindings(result: AuthInspection | null): FindingInput[] {
  if (!result || result.passwordFields === 0) return [];
  const findings: FindingInput[] = [];

  if (result.pasteBlocked.count > 0) {
    findings.push({
      ruleId: "auth-paste-blocked",
      kind: "violation",
      detector: "heuristic",
      impact: "serious",
      title: "Password fields block pasting",
      explanation: "The page cancels paste in these password fields, so neither a password manager nor copy and paste can fill them. People have to remember and retype their password character by character, which is the memory and transcription test WCAG 3.3.8 exists to remove.",
      wcag: SC_3_3_8,
      count: result.pasteBlocked.count,
      occurrences: evidence(result.pasteBlocked),
    });
  }

  // Browsers often guess without these hints, so a missing hint is a real risk
  // rather than a proven failure.
  if (result.autocompleteMissing.count > 0) {
    findings.push({
      ruleId: "auth-autocomplete-missing",
      kind: "advisory",
      detector: "heuristic",
      impact: "moderate",
      title: "Sign-in fields do not tell password managers what they are",
      explanation: "Password managers are the main way people avoid memorising credentials, and they rely on autocomplete=\"username\" and autocomplete=\"current-password\" (or \"new-password\") to fill the right fields. Without them, filling is guesswork and often fails, pushing people back to recalling and typing their password.",
      wcag: SC_3_3_8,
      count: result.autocompleteMissing.count,
      occurrences: evidence(result.autocompleteMissing),
    });
  }

  // Object-recognition CAPTCHAs are allowed at AA and many are passive, so the
  // scan can only say one is present and name what to check.
  if (result.captchas.count > 0) {
    findings.push({
      ruleId: "auth-captcha",
      kind: "advisory",
      detector: "heuristic",
      impact: "moderate",
      title: "A CAPTCHA guards the sign-in form",
      explanation: "WCAG 3.3.8 does not allow a sign-in step that depends on a cognitive test, such as retyping distorted text or solving a puzzle, unless an alternative is offered. Recognising objects in pictures is allowed at AA. Confirm which challenge people actually receive, and that a non-cognitive alternative exists.",
      wcag: SC_3_3_8,
      count: result.captchas.count,
      occurrences: evidence(result.captchas),
    });
  }

  return findings;
}
