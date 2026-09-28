/**
 * The real scanner: renders a submitted page in Cloudflare Browser Rendering and
 * runs axe-core against the rendered DOM.
 *
 * Every part of this treats the target page as hostile. It may redirect somewhere
 * private, try to download files, open dialogs, hang forever, or return megabytes
 * of markup. The guards below are the reason this can be pointed at arbitrary
 * public URLs; do not remove one without replacing it.
 */
import puppeteer from "@cloudflare/puppeteer";
// Bundled as a string so it can be injected into the page. axe-core is never
// executed inside the Worker itself — only in the isolated browser tab.
import axeSource from "axe-core/axe.min.js?raw";
import { normalizeViolations } from "./normalize";
import { walkFocusOrder, keyboardFindings, type KeyboardWalk } from "./keyboard";
import { checkForms, formFindings, type FormInspection } from "./forms";
import { findFakeControls, clickableFindings, type ClickableInspection } from "./interactive";
import { checkAuthentication, authFindings, type AuthInspection } from "./auth";
import { inspectImages, imageFindings, type ImageInspection } from "./images";
import { measureReflowAt, reflowFindings, mergeByViewport, DESKTOP_VIEWPORT, MOBILE_VIEWPORT, type ReflowResult } from "./viewport";
import type { FindingInput, ImageSample } from "../fixes/types";

/** The Browser Rendering binding, as `puppeteer.launch` expects it. */
export type BrowserBinding = Parameters<typeof puppeteer.launch>[0];

export type ScanEnv = { BROWSER?: BrowserBinding };

export type ScanOptions = {
  /** Screenshot images for the AI alt-text review. Off unless that review is enabled. */
  captureImages?: boolean;
};

export type ScanResult = {
  findings: FindingInput[];
  /** Screenshots for the alt-text review; empty unless requested. Never stored. */
  images: ImageSample[];
  finalUrl: string;
  pageTitle: string;
  axeVersion: string;
};

/** Thrown with a message safe to show a user; never carries page content. */
export class ScanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ScanError";
  }
}

const NAVIGATION_TIMEOUT_MS = 25_000;
const AXE_TIMEOUT_MS = 30_000;
/** Each optional pass gets its own budget; overrunning one costs only that pass. */
const EXTRA_PASS_TIMEOUT_MS = 20_000;
/** All optional passes together. Axe (30s) plus this stays under the job ceiling. */
const OPTIONAL_PASSES_BUDGET_MS = 45_000;
/** Ceiling for the whole job, so one page can never hold a browser session open. */
const TOTAL_JOB_TIMEOUT_MS = 90_000;
const VIEWPORT = DESKTOP_VIEWPORT;
const USER_AGENT_SUFFIX = "ClarityAccessibilityScanner/0.1 (+automated accessibility scan)";
/** A navigation redirected more than this many times is looping; stop following it. */
const MAX_REDIRECTS = 20;
/** Client-rendered pages get this long to settle, without waiting for full network idle. */
const SETTLE_MS = 750;
const MOBILE_SETTLE_MS = 400;

/**
 * WCAG 2.x A and AA, plus axe's best-practice set. The two are not equivalent and
 * are never presented as such: `normalize` splits them into `violation` and
 * `advisory` by tag, and only violations count toward the report's totals.
 */
const AXE_RUN_OPTIONS = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
  resultTypes: ["violations"],
  // Keep the payload small; we re-derive everything we need from violations.
  elementRef: false,
  selectors: true,
  ancestry: false,
  xpath: false,
};

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
type HostnameGuard = (hostname: string) => boolean;
type Warn = (message: string) => void;

function withTimeout<T>(promise: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ScanError(code, message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Runs the scan. `isBlockedHostname` is injected rather than imported so the guard
 * has exactly one definition in the worker; this module must not own a second copy.
 */
export async function scanPage(
  targetUrl: string,
  env: ScanEnv,
  isBlockedHostname: HostnameGuard,
  onWarning?: Warn,
  options: ScanOptions = {},
): Promise<ScanResult> {
  if (!env.BROWSER) throw new ScanError("browser_unavailable", "The scanner is not available right now.");

  const browser = await puppeteer.launch(env.BROWSER);

  try {
    return await withTimeout(
      runScan(browser, targetUrl, isBlockedHostname, options, onWarning),
      TOTAL_JOB_TIMEOUT_MS,
      "scan_timeout",
      "This page took too long to scan.",
    );
  } finally {
    // Always release the session. Leaking one burns the concurrent-browser budget.
    await browser.close().catch(() => {});
  }
}

async function runScan(browser: Browser, targetUrl: string, isBlockedHostname: HostnameGuard, options: ScanOptions, onWarning?: Warn): Promise<ScanResult> {
  const page = await openGuardedPage(browser, isBlockedHostname, onWarning);
  const finalUrl = await navigate(page, targetUrl, isBlockedHostname);
  const desktop = await runDesktopAxe(page);
  const desktopFindings = normalizeViolations(desktop.violations);
  const passes = await runOptionalPasses(page, options, onWarning);

  onWarning?.([`axe ${desktopFindings.length} rules desktop / ${passes.mobileFindings.length} mobile`, ...passes.summaries].join(" | "));

  return {
    findings: [...mergeByViewport(desktopFindings, passes.mobileFindings), ...passes.findings],
    images: passes.images,
    finalUrl,
    pageTitle: desktop.title.trim().slice(0, 200) || new URL(finalUrl).hostname,
    axeVersion: desktop.version || "4.x",
  };
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isScannable(url: URL, isBlockedHostname: HostnameGuard) {
  return ["http:", "https:"].includes(url.protocol) && !isBlockedHostname(url.hostname);
}

const wait = (page: Page, ms: number) => page.evaluate((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)), ms);

/** A fresh tab that dismisses dialogs and refuses every request to a non-public destination. */
async function openGuardedPage(browser: Browser, isBlockedHostname: HostnameGuard, onWarning?: Warn) {
  const page = await browser.newPage();

  await page.setViewport(VIEWPORT);
  await page.setCacheEnabled(false);
  await page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  const userAgent = await browser.userAgent().catch(() => "");
  await page.setUserAgent(`${userAgent} ${USER_AGENT_SUFFIX}`.trim());

  // A page that opens a dialog would otherwise block navigation until timeout.
  page.on("dialog", (dialog) => { dialog.dismiss().catch(() => {}); });

  /**
   * Revalidate the destination on every request the page makes, not just the first.
   * A public hostname can redirect to a private one, and subresources are requests
   * we did not validate at submission time.
   */
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const target = parseUrl(request.url());
    const redirectLoop = request.isNavigationRequest() && request.redirectChain().length > MAX_REDIRECTS;
    if (target && isScannable(target, isBlockedHostname) && !redirectLoop) {
      request.continue().catch(() => {});
      return;
    }
    if (target) onWarning?.(`blocked request to ${target.protocol}//${target.hostname}`);
    request.abort().catch(() => {});
  });

  return page;
}

/** Load the page and return the URL it finally landed on, which must itself be scannable. */
async function navigate(page: Page, targetUrl: string, isBlockedHostname: HostnameGuard) {
  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
    .catch((error: unknown) => {
      throw new ScanError("navigation_failed", navigationMessage(error));
    });

  if (!response) throw new ScanError("navigation_failed", "This page did not respond.");
  const status = response.status();
  if (status >= 400) throw new ScanError("http_error", `The page returned HTTP ${status}.`);

  // The submitted URL was validated, but the URL we actually landed on may differ.
  const finalUrl = page.url();
  const landed = parseUrl(finalUrl);
  if (!landed) throw new ScanError("redirect_blocked", "This page redirected somewhere that could not be validated.");
  if (!isScannable(landed, isBlockedHostname)) throw new ScanError("redirect_blocked", "This page redirected to a destination that cannot be scanned.");

  await wait(page, SETTLE_MS).catch(() => {});
  return finalUrl;
}

/** Run the already-injected axe in the page. Null means axe is not on the page. */
function evaluateAxe(page: Page) {
  return page.evaluate(async (options) => {
    const globalAxe = (globalThis as unknown as { axe?: { run: (opts: unknown) => Promise<unknown>; version?: string } }).axe;
    if (!globalAxe) return null;
    const results = await globalAxe.run(options) as { violations?: unknown };
    return { violations: results?.violations ?? [], version: globalAxe.version ?? "", title: document.title || "" };
  }, AXE_RUN_OPTIONS as unknown as Record<string, unknown>);
}

/** The desktop axe pass. This one is the product's floor, so any failure fails the scan. */
async function runDesktopAxe(page: Page) {
  await page.addScriptTag({ content: axeSource }).catch(() => {
    throw new ScanError("axe_injection_failed", "The accessibility engine could not run on this page.");
  });

  const result = await withTimeout(evaluateAxe(page), AXE_TIMEOUT_MS, "axe_timeout", "The accessibility checks took too long on this page.")
    .catch((error: unknown) => {
      if (error instanceof ScanError) throw error;
      throw new ScanError("axe_failed", "The accessibility checks could not complete on this page.");
    });

  if (!result) throw new ScanError("axe_failed", "The accessibility engine did not load on this page.");
  return {
    violations: result.violations,
    title: typeof result.title === "string" ? result.title : "",
    version: typeof result.version === "string" ? result.version : "",
  };
}

type PassResults = {
  keyboard: KeyboardWalk | null;
  forms: FormInspection | null;
  clickable: ClickableInspection | null;
  auth: AuthInspection | null;
  images: ImageInspection | null;
  reflow: ReflowResult | null;
};

/**
 * A pass that caught an error returns the same empty result as a clean page, so
 * say what each one actually did. Without this, a silently broken check is
 * indistinguishable from a page with nothing wrong.
 */
function passSummaries({ keyboard, forms, clickable, auth, images, reflow }: PassResults) {
  return [
    keyboard ? `keyboard ${keyboard.steps.length} stops of ${keyboard.focusableCount} focusable` : "keyboard unavailable",
    forms ? `forms ${forms.fieldCount} fields` : "forms unavailable",
    clickable ? `clickable ${clickable.fakeControls.count} of ${clickable.candidateCount} pointer elements` : "clickable unavailable",
    auth ? `sign-in ${auth.passwordFields} password fields` : "sign-in unavailable",
    images ? `images ${images.images.length} with alt, ${images.samples.length} captured` : "images unavailable",
    reflow ? `reflow ${reflow.scrollWidth}px in ${reflow.clientWidth}px` : "reflow unavailable",
  ];
}

/**
 * Keyboard, form, clickable, sign-in, image, mobile and reflow checks. All are
 * additive: the desktop axe pass is the product's floor, and a pass that times out
 * or throws contributes nothing and is logged, but it must never cost the caller
 * the results already in hand. They share one budget, so together they can never
 * push the job past its own ceiling and fail the scan.
 */
async function runOptionalPasses(page: Page, options: ScanOptions, onWarning?: Warn) {
  const deadline = Date.now() + OPTIONAL_PASSES_BUDGET_MS;
  const optional = async <T>(label: string, run: () => Promise<T>, empty: T): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      onWarning?.(`${label} skipped: out of time`);
      return empty;
    }
    try {
      return await withTimeout(run(), Math.min(EXTRA_PASS_TIMEOUT_MS, remaining), "pass_timeout", `${label} timed out`);
    } catch (error) {
      onWarning?.(`${label} skipped: ${error instanceof Error ? error.message : "failed"}`);
      return empty;
    }
  };

  // Keyboard walk before any resize, so recorded positions match the desktop layout.
  const keyboard = await optional("keyboard walk", () => walkFocusOrder(page), null);
  // After the walk: fields that validate on blur have now been tabbed through, so
  // their errors are showing — the only error states reachable without typing.
  const forms = await optional("form checks", () => checkForms(page), null);
  const clickable = await optional("clickable check", () => findFakeControls(page), null);
  // Dispatches a synthetic paste, so it runs after the read-only passes.
  const auth = await optional("sign-in checks", () => checkAuthentication(page), null);
  const images = await optional("image checks", () => inspectImages(page, options.captureImages ?? false), null);

  const mobileFindings = await optional("mobile pass", async () => {
    await page.setViewport(MOBILE_VIEWPORT);
    await wait(page, MOBILE_SETTLE_MS);
    const mobile = await evaluateAxe(page);
    return mobile ? normalizeViolations(mobile.violations) : [];
  }, [] as FindingInput[]);

  const reflow = await optional("reflow pass", () => measureReflowAt(page), null);

  return {
    mobileFindings,
    images: images?.samples ?? [],
    summaries: passSummaries({ keyboard, forms, clickable, auth, images, reflow }),
    findings: [
      ...keyboardFindings(keyboard),
      ...formFindings(forms),
      ...clickableFindings(clickable),
      ...authFindings(auth),
      ...imageFindings(images),
      ...reflowFindings(reflow),
    ],
  };
}

function navigationMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(message)) return "This page took too long to load.";
  if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS/i.test(message)) return "This address could not be resolved.";
  if (/ERR_CERT|SSL/i.test(message)) return "This page has a TLS certificate problem.";
  if (/ERR_CONNECTION|ERR_ABORTED|net::/i.test(message)) return "This page could not be reached.";
  return "This page could not be loaded.";
}
