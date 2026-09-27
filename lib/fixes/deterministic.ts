/**
 * Deterministic axe/WCAG guidance.
 *
 * This is the product's floor, not a stopgap: it runs when no model provider is
 * configured, when a model call fails, and for any rule group a model declined
 * to answer. Clarity prefers known-correct guidance over generated text.
 */
import type { Confidence, FindingInput, FixSuggestion } from "./types";

const DETERMINISTIC_PROVIDER = "deterministic";
const DETERMINISTIC_MODEL = "axe-wcag-guidance";
const DETERMINISTIC_PROMPT_VERSION = "static-1";

type FixBody = {
  summary: string;
  whyItMatters: string;
  steps: string[];
  codeExample: string | null;
  confidence: Confidence;
  requiresManualReview: boolean;
};

const LIBRARY: Record<string, FixBody> = {
  "button-name": {
    summary: "Give each icon button a short, action-oriented accessible name.",
    whyItMatters: "A visible icon may suggest meaning to sighted users, but assistive technology needs a programmatic name.",
    steps: ["Add aria-label to controls whose icon already communicates the action visually.", "Use a name that describes the action, such as “Open cart” or “Close search”.", "Retest the control with its open and closed states."],
    codeExample: "<button class=\"cart-toggle\" aria-label=\"Open cart\">\n  <span class=\"cart-icon\" aria-hidden=\"true\"></span>\n</button>",
    confidence: "high",
    requiresManualReview: true,
  },
  "color-contrast": {
    summary: "Darken the muted text color until normal text reaches at least 4.5:1.",
    whyItMatters: "Low-contrast text can disappear for users with low vision, color-vision differences, or a low-quality display.",
    steps: ["Update the muted text token instead of patching each component.", "Verify normal text reaches 4.5:1 and large text reaches 3:1.", "Check hover, focus, disabled, and dark-mode states separately."],
    codeExample: ":root {\n  --text-muted: #5b625e; /* 5.1:1 on #ffffff */\n}",
    confidence: "medium",
    requiresManualReview: true,
  },
  "image-alt": {
    summary: "Decide whether each image is informative, functional, or decorative before adding alt text.",
    whyItMatters: "Good alternative text depends on the image’s purpose in this exact context, not only what the image contains.",
    steps: ["Describe information conveyed by meaningful images concisely.", "Use alt=\"\" for genuinely decorative images.", "Avoid repeating nearby visible text."],
    codeExample: null,
    confidence: "low",
    requiresManualReview: true,
  },
  label: {
    summary: "Associate a visible label with every input using matching for and id values.",
    whyItMatters: "Labels help everyone understand what to enter and give assistive technology a reliable field name.",
    steps: ["Add a visible label whenever the design allows.", "Match the label’s for value to the input id.", "Keep placeholder text as an example, not as the only label."],
    codeExample: "<label for=\"newsletter-email\">Email address</label>\n<input id=\"newsletter-email\" type=\"email\" autocomplete=\"email\">",
    confidence: "high",
    requiresManualReview: true,
  },
  "keyboard-trap": {
    summary: "Let keyboard focus move out of this element in both directions.",
    whyItMatters: "A keyboard-only user who cannot Tab past a control is stuck: the rest of the page becomes unreachable without reloading.",
    steps: ["Find the handler intercepting Tab or calling preventDefault on keydown, and let Tab through.", "If focus is held deliberately, as in a dialog, close it on Escape and return focus to the trigger.", "Retest by tabbing from the top of the page to the very end."],
    codeExample: "// Trap focus inside a dialog, but always offer a way out.\ndialog.addEventListener(\"keydown\", (event) => {\n  if (event.key === \"Escape\") close();\n});",
    confidence: "medium",
    requiresManualReview: true,
  },
  "keyboard-trap-cycle": {
    summary: "Give the widget holding focus a documented way to release it.",
    whyItMatters: "Focus circling inside a small group of controls means a keyboard user can never reach the rest of the page.",
    steps: ["Identify the dialog, menu, or embedded frame holding focus.", "Close it on Escape and restore focus to the element that opened it.", "Verify Tab eventually reaches the page footer."],
    codeExample: null,
    confidence: "medium",
    requiresManualReview: true,
  },
  "focus-on-hidden-element": {
    summary: "Remove hidden elements from the tab order until they are visible.",
    whyItMatters: "Focus landing on something invisible makes the page feel broken: the highlight vanishes and the next keypress goes somewhere unexpected.",
    steps: ["Hide offscreen menus with display:none or visibility:hidden rather than opacity or a transform.", "Or set tabindex=\"-1\" on the controls while the container is closed.", "Keep genuine skip links focusable — they are supposed to appear on focus."],
    codeExample: ".menu[hidden] { display: none; }\n/* or */\n.drawer:not(.is-open) a { visibility: hidden; }",
    confidence: "medium",
    requiresManualReview: true,
  },
  "focus-not-visible": {
    summary: "Give every focusable control a clearly visible focus indicator.",
    whyItMatters: "Without a visible indicator a keyboard user cannot tell which control they are about to activate.",
    steps: ["Never remove an outline without replacing it — `outline: none` alone is the usual cause.", "Use :focus-visible so the indicator appears for keyboard use without showing on every mouse click.", "Aim for a thick, high-contrast indicator against both the control and the page background."],
    codeExample: ":focus-visible {\n  outline: 3px solid #1a56db;\n  outline-offset: 2px;\n}",
    confidence: "high",
    requiresManualReview: true,
  },
  "focus-order-jumps": {
    summary: "Check that the tab sequence still matches the page's reading order.",
    whyItMatters: "Tab order follows the DOM. When CSS reorders content visually, keyboard users get a sequence that does not match what they see.",
    steps: ["Compare the tab sequence against the visual reading order.", "Reorder the markup rather than reaching for positive tabindex values.", "Be careful with flexbox `order` and grid placement, which are the usual causes."],
    codeExample: null,
    confidence: "low",
    requiresManualReview: true,
  },
  "reflow-horizontal-scroll": {
    summary: "Let the layout reflow to a single column instead of scrolling sideways.",
    whyItMatters: "Reading a page that scrolls in two directions is slow and error-prone, especially for people who zoom in heavily.",
    steps: ["Find the element extending past the viewport — usually a fixed width, a wide table, or an unwrapped code block.", "Replace fixed pixel widths with max-width: 100% and let content wrap.", "Give genuinely wide content, like a data table, its own scroll container instead of scrolling the page."],
    codeExample: "img, video, table { max-width: 100%; }\n.table-wrap { overflow-x: auto; }",
    confidence: "medium",
    requiresManualReview: false,
  },
  "html-has-lang": {
    summary: "Set the page’s primary human language on the html element.",
    whyItMatters: "Assistive technology uses this value to select the right voice and pronunciation rules.",
    steps: ["Set lang to the page’s primary language code.", "Mark passages in another language with their own lang attribute."],
    codeExample: "<html lang=\"en\">",
    confidence: "high",
    requiresManualReview: false,
  },
};

function generic(finding: FindingInput): FixBody {
  return {
    summary: `Resolve “${finding.title}” across the ${finding.count} affected ${finding.count === 1 ? "element" : "elements"}.`,
    whyItMatters: finding.explanation,
    steps: [
      "Review each affected element in the evidence above.",
      "Apply the guidance in the linked WCAG success criterion.",
      "Re-run the scan and retest with a keyboard and a screen reader.",
    ],
    codeExample: null,
    confidence: "low",
    requiresManualReview: true,
  };
}

export function deterministicFix(finding: FindingInput): FixSuggestion {
  return {
    ...(LIBRARY[finding.ruleId] ?? generic(finding)),
    provider: DETERMINISTIC_PROVIDER,
    model: DETERMINISTIC_MODEL,
    promptVersion: DETERMINISTIC_PROMPT_VERSION,
  };
}
