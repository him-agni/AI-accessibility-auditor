/**
 * Fake interactive elements — divs and spans that act as buttons.
 *
 * An element with a click handler and a pointer cursor looks and works like a
 * control for a mouse user. Without a role or a tabindex, a keyboard user can
 * never reach it and a screen reader never announces it. axe cannot see this:
 * it reads markup, and a click handler is not markup.
 *
 * Handlers are found three ways, because frameworks attach them differently:
 *  - DevTools `getEventListeners`, for handlers added with addEventListener
 *    (plain JS, Vue, Angular, Svelte, Preact);
 *  - framework props on the node, for libraries that delegate to the root
 *    (React's `__reactProps$…`, Solid's `$$click`);
 *  - the `onclick` property, for inline handlers.
 * Handlers delegated through a shared ancestor by hand, as in jQuery's
 * `$(document).on("click", ".x")`, are invisible to all three and are missed.
 *
 * Best-effort: a failure returns no findings.
 */
import type { FindingInput, Occurrence } from "../fixes/types";

/** Pointer-cursor elements checked for handlers. Each costs two DevTools calls. */
const MAX_CANDIDATES = 120;
const MAX_EVIDENCE = 4;
const CLICK_EVENTS = new Set(["click", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"]);

export type FakeControl = { selector: string; html: string; handler: string };

export type ClickableInspection = {
  /** Pointer-cursor elements with no role or tabindex that were checked. */
  candidateCount: number;
  fakeControls: { count: number; sample: FakeControl[] };
};

type Candidate = { index: number; selector: string; html: string; handler: string | null };

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

interface ClickablePage {
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  createCDPSession(): Promise<CdpSession>;
}

/* -- runs inside the page; it must not close over anything in this module -- */

/**
 * Tag each pointer-cursor element that is not already a control, and report any
 * handler visible from inside the page. Only the outermost element of a pointer
 * region is taken, because `cursor` inherits to every descendant.
 */
function markCandidates(max: number): Candidate[] {
  const CONTROLS = 'a[href], button, input, select, textarea, summary, label, option, iframe, video, audio, [contenteditable=""], [contenteditable="true"], [tabindex], [role]';
  const INNER_TARGETS = 'a[href], button, input, select, textarea, [tabindex], [role="button"], [role="link"]';

  const isShown = (el: Element) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.opacity !== "0";
  };

  const hasPointer = (el: Element | null) => el !== null && getComputedStyle(el).cursor === "pointer";

  const pageHandler = (el: Element) => {
    const node = el as unknown as Record<string, unknown>;
    if (typeof node.onclick === "function") return "inline onclick";
    if (typeof node.$$click === "function") return "Solid onClick";
    const reactKey = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
    const props = reactKey ? node[reactKey] as Record<string, unknown> | null : null;
    if (props && ["onClick", "onMouseDown", "onPointerDown"].some((name) => typeof props[name] === "function")) return "React onClick";
    return null;
  };

  const candidates: Candidate[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest(CONTROLS) || !hasPointer(el)) continue;
    const parent = el.parentElement;
    if (parent && hasPointer(parent) && !parent.closest(CONTROLS)) continue;
    // A clickable card whose real target is a link inside it works by keyboard already.
    if (el.querySelector(INNER_TARGETS) || !isShown(el)) continue;

    const index = candidates.length;
    el.setAttribute("data-clarity-click", String(index));
    let selector = el.tagName.toLowerCase();
    if (el.id) selector += `#${el.id}`;
    else if (el.classList.length) selector += `.${[...el.classList].slice(0, 2).join(".")}`;
    candidates.push({ index, selector, html: (el.outerHTML || "").slice(0, 300), handler: pageHandler(el) });
    if (candidates.length >= max) break;
  }
  return candidates;
}

/* -- DevTools side -- */

type RemoteObject = { result?: { objectId?: string } };
type Listeners = { listeners?: { type?: string }[] };

/** The first click-like listener attached directly to a tagged candidate, if any. */
async function listenerOn(session: CdpSession, index: number) {
  const found = await session.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-clarity-click="${index}"]')`,
    objectGroup: "clarity-click",
  }) as RemoteObject;
  const objectId = found.result?.objectId;
  if (!objectId) return null;

  const { listeners = [] } = await session.send("DOMDebugger.getEventListeners", { objectId }) as Listeners;
  const click = listeners.find((listener) => CLICK_EVENTS.has(listener.type ?? ""));
  return click ? `${click.type} listener` : null;
}

/** Find elements that respond to clicks but are not controls. Returns null on any failure. */
export async function findFakeControls(page: ClickablePage): Promise<ClickableInspection | null> {
  let session: CdpSession | null = null;
  try {
    const candidates = await page.evaluate(markCandidates, MAX_CANDIDATES);
    const unresolved = candidates.filter((candidate) => !candidate.handler);

    if (unresolved.length > 0) {
      session = await page.createCDPSession();
      const cdp = session;
      // Independent lookups, so send them together rather than one round trip each.
      const handlers = await Promise.all(unresolved.map((candidate) => listenerOn(cdp, candidate.index).catch(() => null)));
      unresolved.forEach((candidate, position) => { candidate.handler = handlers[position]; });
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "clarity-click" }).catch(() => {});
    }

    const fake = candidates
      .filter((candidate): candidate is Candidate & { handler: string } => candidate.handler !== null)
      .map(({ selector, html, handler }) => ({ selector, html, handler }));
    return { candidateCount: candidates.length, fakeControls: { count: fake.length, sample: fake.slice(0, 8) } };
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => {});
  }
}

/** Turn the inspection into a report finding. Carries `detector: "heuristic"`. */
export function clickableFindings(result: ClickableInspection | null): FindingInput[] {
  if (!result || result.fakeControls.count === 0) return [];
  const { count, sample } = result.fakeControls;

  return [{
    ruleId: "fake-interactive-element",
    kind: "violation",
    detector: "heuristic",
    impact: "serious",
    title: "Clickable elements cannot be reached or identified by keyboard",
    explanation: "These elements respond to clicks and show a pointer cursor, but they are plain elements with no role and no tabindex. A keyboard user can never Tab to them, and a screen reader does not announce them as buttons or links, so whatever they do is unavailable without a mouse.",
    wcag: [
      { label: "2.1.1 Keyboard", href: "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html" },
      { label: "4.1.2 Name, Role, Value", href: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html" },
    ],
    count,
    occurrences: sample.slice(0, MAX_EVIDENCE).map((control): Occurrence => ({
      selector: control.selector,
      html: control.html || "(markup not captured)",
      failure: `Has a ${control.handler} and a pointer cursor, but no role or tabindex.`,
    })),
  }];
}
