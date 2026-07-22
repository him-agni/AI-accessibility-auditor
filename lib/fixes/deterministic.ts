/**
 * Deterministic axe/WCAG guidance.
 *
 * This is the product's floor, not a stopgap: it runs when no model provider is
 * configured, when a model call fails, and for any rule group a model declined
 * to answer. Clarity prefers known-correct guidance over generated text.
 */
import type { Confidence, FindingInput, FixSuggestion } from "./types";

export const DETERMINISTIC_PROVIDER = "deterministic";
export const DETERMINISTIC_MODEL = "axe-wcag-guidance";
export const DETERMINISTIC_PROMPT_VERSION = "static-1";

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
