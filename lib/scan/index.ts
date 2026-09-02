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
import type { FindingInput } from "../fixes/types";

/** The Browser Rendering binding, as `puppeteer.launch` expects it. */
export type BrowserBinding = Parameters<typeof puppeteer.launch>[0];

export type ScanEnv = { BROWSER?: BrowserBinding };

export type ScanResult = {
  findings: FindingInput[];
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
/** Ceiling for the whole job, so one page can never hold a browser session open. */
const TOTAL_JOB_TIMEOUT_MS = 55_000;
const VIEWPORT = { width: 1440, height: 900 };
const USER_AGENT_SUFFIX = "ClarityAccessibilityScanner/0.1 (+automated accessibility scan)";

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
  isBlockedHostname: (hostname: string) => boolean,
  onWarning?: (message: string) => void,
): Promise<ScanResult> {
  if (!env.BROWSER) throw new ScanError("browser_unavailable", "The scanner is not available right now.");

  const browser = await puppeteer.launch(env.BROWSER);

  try {
    return await withTimeout(
      runScan(browser, targetUrl, isBlockedHostname, onWarning),
      TOTAL_JOB_TIMEOUT_MS,
      "scan_timeout",
      "This page took too long to scan.",
    );
  } finally {
    // Always release the session. Leaking one burns the concurrent-browser budget.
    await browser.close().catch(() => {});
  }
}

async function runScan(
  browser: Awaited<ReturnType<typeof puppeteer.launch>>,
  targetUrl: string,
  isBlockedHostname: (hostname: string) => boolean,
  onWarning?: (message: string) => void,
): Promise<ScanResult> {
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
    let hostname = "";
    let protocol = "";
    try {
      const parsed = new URL(request.url());
      hostname = parsed.hostname;
      protocol = parsed.protocol;
    } catch {
      request.abort().catch(() => {});
      return;
    }

    const isDownload = request.isNavigationRequest() && request.redirectChain().length > 20;
    if (!["http:", "https:"].includes(protocol) || isBlockedHostname(hostname) || isDownload) {
      onWarning?.(`blocked request to ${protocol}//${hostname}`);
      request.abort().catch(() => {});
      return;
    }
    request.continue().catch(() => {});
  });

  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
    .catch((error: unknown) => {
      throw new ScanError("navigation_failed", navigationMessage(error));
    });

  if (!response) throw new ScanError("navigation_failed", "This page did not respond.");
  const status = response.status();
  if (status >= 400) throw new ScanError("http_error", `The page returned HTTP ${status}.`);

  // The submitted URL was validated, but the URL we actually landed on may differ.
  const finalUrl = page.url();
  try {
    const landed = new URL(finalUrl);
    if (!["http:", "https:"].includes(landed.protocol) || isBlockedHostname(landed.hostname)) {
      throw new ScanError("redirect_blocked", "This page redirected to a destination that cannot be scanned.");
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError("redirect_blocked", "This page redirected somewhere that could not be validated.");
  }

  // Give client-rendered pages a moment to settle without waiting for full idle,
  // which many pages with polling or analytics never reach.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 750))).catch(() => {});

  await page.addScriptTag({ content: axeSource }).catch(() => {
    throw new ScanError("axe_injection_failed", "The accessibility engine could not run on this page.");
  });

  const raw = await withTimeout(
    page.evaluate(async (options) => {
      const globalAxe = (globalThis as unknown as { axe?: { run: (opts: unknown) => Promise<unknown>; version?: string } }).axe;
      if (!globalAxe) return null;
      const results = await globalAxe.run(options) as { violations?: unknown };
      return { violations: results?.violations ?? [], version: globalAxe.version ?? "", title: document.title || "" };
    }, AXE_RUN_OPTIONS as unknown as Record<string, unknown>),
    AXE_TIMEOUT_MS,
    "axe_timeout",
    "The accessibility checks took too long on this page.",
  ).catch((error: unknown) => {
    if (error instanceof ScanError) throw error;
    throw new ScanError("axe_failed", "The accessibility checks could not complete on this page.");
  });

  if (!raw) throw new ScanError("axe_failed", "The accessibility engine did not load on this page.");

  const pageTitle = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 200) : new URL(finalUrl).hostname;

  return {
    findings: normalizeViolations(raw.violations),
    finalUrl,
    pageTitle,
    axeVersion: typeof raw.version === "string" && raw.version ? raw.version : "4.x",
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
