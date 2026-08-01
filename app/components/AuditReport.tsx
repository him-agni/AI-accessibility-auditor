"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type Impact = "critical" | "serious" | "moderate" | "minor";

type Finding = {
  ruleId: string;
  impact: Impact;
  title: string;
  explanation: string;
  wcag: { label: string; href: string }[];
  count: number;
  occurrences: { selector: string; html: string; failure: string }[];
  fix: {
    summary: string;
    whyItMatters: string;
    steps: string[];
    codeExample: string | null;
    confidence: "high" | "medium" | "low";
    requiresManualReview: boolean;
  };
};

type Audit = {
  id: string;
  url: string;
  finalUrl: string;
  pageTitle: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  findings: Finding[];
  error?: string;
  prototype?: boolean;
};

const SAMPLE_FINDINGS: Finding[] = [
  {
    ruleId: "button-name",
    impact: "critical",
    title: "Buttons must have discernible text",
    explanation: "Two icon-only buttons have no accessible name. Screen-reader users hear only “button” and cannot tell what each control does.",
    wcag: [{ label: "4.1.2 Name, Role, Value", href: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html" }],
    count: 2,
    occurrences: [
      { selector: ".site-header > button.cart-toggle", html: "<button class=\"cart-toggle\"><span class=\"cart-icon\"></span></button>", failure: "Element does not have inner text that is visible to screen readers, an aria-label, or an aria-labelledby attribute." },
      { selector: ".search-panel > button.close", html: "<button class=\"close\"><span aria-hidden=\"true\">×</span></button>", failure: "Element does not have an accessible name." },
    ],
    fix: {
      summary: "Give each icon button a short, action-oriented accessible name.",
      whyItMatters: "A visible icon may suggest meaning to sighted users, but assistive technology needs a programmatic name.",
      steps: ["Add aria-label to controls whose icon already communicates the action visually.", "Use a name that describes the action, such as “Open cart” or “Close search”.", "Retest the control with its open and closed states."],
      codeExample: "<button class=\"cart-toggle\" aria-label=\"Open cart\">\n  <span class=\"cart-icon\" aria-hidden=\"true\"></span>\n</button>",
      confidence: "high",
      requiresManualReview: true,
    },
  },
  {
    ruleId: "color-contrast",
    impact: "serious",
    title: "Text must meet minimum color contrast",
    explanation: "Several text elements do not have enough contrast against their backgrounds, making them difficult to read for people with low vision.",
    wcag: [{ label: "1.4.3 Contrast (Minimum)", href: "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html" }],
    count: 12,
    occurrences: [
      { selector: ".product-card .eyebrow", html: "<span class=\"eyebrow\">New arrival</span>", failure: "Element has insufficient color contrast of 2.61:1. Expected 4.5:1 for this text size." },
      { selector: ".footer .legal-link", html: "<a class=\"legal-link\" href=\"/returns\">Returns</a>", failure: "Element has insufficient color contrast of 3.02:1. Expected 4.5:1." },
    ],
    fix: {
      summary: "Darken the muted text color until normal text reaches at least 4.5:1.",
      whyItMatters: "Low-contrast text can disappear for users with low vision, color-vision differences, or a low-quality display.",
      steps: ["Update the muted text token instead of patching each component.", "Verify normal text reaches 4.5:1 and large text reaches 3:1.", "Check hover, focus, disabled, and dark-mode states separately."],
      codeExample: ":root {\n  --text-muted: #5b625e; /* 5.1:1 on #ffffff */\n}",
      confidence: "medium",
      requiresManualReview: true,
    },
  },
  {
    ruleId: "image-alt",
    impact: "serious",
    title: "Images must have alternative text",
    explanation: "Three images are missing alt attributes. Their purpose cannot be determined from markup alone.",
    wcag: [{ label: "1.1.1 Non-text Content", href: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html" }],
    count: 3,
    occurrences: [
      { selector: ".hero-promo > img", html: "<img src=\"/summer-collection.webp\">", failure: "Element does not have an alt attribute." },
      { selector: ".product-card:nth-child(2) img", html: "<img src=\"/linen-shirt.webp\">", failure: "Element does not have an alt attribute." },
    ],
    fix: {
      summary: "Decide whether each image is informative, functional, or decorative before adding alt text.",
      whyItMatters: "Good alternative text depends on the image’s purpose in this exact context, not only what the image contains.",
      steps: ["Describe information conveyed by meaningful images concisely.", "Use alt=\"\" for genuinely decorative images.", "Avoid repeating nearby visible text."],
      codeExample: null,
      confidence: "low",
      requiresManualReview: true,
    },
  },
  {
    ruleId: "label",
    impact: "serious",
    title: "Form inputs must have labels",
    explanation: "Four fields are missing programmatically associated labels, so their purpose may be unclear outside the visual layout.",
    wcag: [{ label: "3.3.2 Labels or Instructions", href: "https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html" }],
    count: 4,
    occurrences: [
      { selector: "#newsletter-email", html: "<input id=\"newsletter-email\" type=\"email\" placeholder=\"Email address\">", failure: "Form element does not have an implicit or explicit label." },
      { selector: "#search-products", html: "<input id=\"search-products\" type=\"search\">", failure: "Form element does not have an accessible name." },
    ],
    fix: {
      summary: "Associate a visible label with every input using matching for and id values.",
      whyItMatters: "Labels help everyone understand what to enter and give assistive technology a reliable field name.",
      steps: ["Add a visible label whenever the design allows.", "Match the label’s for value to the input id.", "Keep placeholder text as an example, not as the only label."],
      codeExample: "<label for=\"newsletter-email\">Email address</label>\n<input id=\"newsletter-email\" type=\"email\" autocomplete=\"email\">",
      confidence: "high",
      requiresManualReview: true,
    },
  },
  {
    ruleId: "html-has-lang",
    impact: "moderate",
    title: "The page must declare a language",
    explanation: "The html element has no lang attribute. Screen readers may use the wrong pronunciation rules.",
    wcag: [{ label: "3.1.1 Language of Page", href: "https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html" }],
    count: 1,
    occurrences: [
      { selector: "html", html: "<html>", failure: "The <html> element does not have a lang attribute." },
    ],
    fix: {
      summary: "Set the page’s primary human language on the html element.",
      whyItMatters: "Assistive technology uses this value to select the right voice and pronunciation rules.",
      steps: ["Set lang to the page’s primary language code.", "Mark passages in another language with their own lang attribute."],
      codeExample: "<html lang=\"en\">",
      confidence: "high",
      requiresManualReview: false,
    },
  },
];

function sampleAudit(id: string, url: string): Audit {
  let host = "shop.example.com";
  try { host = new URL(url).hostname; } catch { /* use sample host */ }
  return {
    id,
    url,
    finalUrl: url,
    pageTitle: `${host} — scanned page`,
    status: "completed",
    createdAt: new Date(Date.now() - 9100).toISOString(),
    completedAt: new Date().toISOString(),
    findings: SAMPLE_FINDINGS,
    prototype: true,
  };
}

const FILTERS = ["all", "critical", "serious", "moderate", "minor"] as const;

export function AuditReport({ auditId }: { auditId: string }) {
  const params = useSearchParams();
  const submittedUrl = params.get("url") || "https://shop.example.com/products";
  const [audit, setAudit] = useState<Audit | null>(null);
  const [status, setStatus] = useState<"queued" | "running" | "failed">("queued");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      attempts += 1;
      if (attempts > 1) setStatus("running");
      try {
        const response = await fetch(`/api/audits/${auditId}`, { cache: "no-store" });
        const result = await response.json() as Audit;
        if (!response.ok) throw new Error(result.error || "Scan unavailable");
        if (cancelled) return;
        if (result.status === "completed") setAudit(result);
        else if (result.status === "failed") setStatus("failed");
        else timer = setTimeout(poll, 1200);
      } catch {
        if (cancelled) return;
        timer = setTimeout(() => setAudit(sampleAudit(auditId, submittedUrl)), 1900);
      }
    }

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [auditId, submittedUrl]);

  const visibleFindings = useMemo(() => audit?.findings.filter((finding) => filter === "all" || finding.impact === filter) || [], [audit, filter]);
  const totalElements = audit?.findings.reduce((sum, finding) => sum + finding.count, 0) || 0;
  const impactCounts = audit?.findings.reduce<Record<string, number>>((acc, finding) => ({ ...acc, [finding.impact]: (acc[finding.impact] || 0) + 1 }), {}) || {};

  async function copyCode(key: string, code: string) {
    await navigator.clipboard.writeText(code);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  if (!audit) {
    return (
      <main className="scan-progress-page">
        <header className="report-nav">
          <Link className="brand" href="/"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Clarity</span></Link>
          <span className="secure-note"><i /> Isolated browser session</span>
        </header>
        <section className="progress-card" aria-live="polite">
          <div className="radar" aria-hidden="true"><i /><i /><i /><span /></div>
          <span className="section-kicker">SCAN IN PROGRESS</span>
          <h1>{status === "queued" ? "Getting the browser ready…" : status === "failed" ? "This page could not be scanned" : "Checking the rendered page…"}</h1>
          <p className="progress-url">{submittedUrl}</p>
          <div className="progress-steps">
            <span className="done"><i>✓</i> URL validated</span>
            <span className={status === "running" ? "done" : "active"}><i>{status === "running" ? "✓" : "2"}</i> Browser launched</span>
            <span className={status === "running" ? "active" : ""}><i>3</i> Running accessibility checks</span>
            <span><i>4</i> Grouping findings</span>
          </div>
          <small>Most single-page scans finish in under a minute.</small>
        </section>
      </main>
    );
  }

  return (
    <main className="report-page">
      <header className="report-nav">
        <Link className="brand" href="/"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Clarity</span></Link>
        <Link className="new-scan" href="/">+ New scan</Link>
      </header>

      <div className="report-shell">
        <div className="breadcrumb"><Link href="/">Scans</Link><span>/</span><span>Report</span></div>
        <section className="report-heading">
          <div>
            <div className="report-status"><span>● Scan complete</span><time>{new Date(audit.completedAt || audit.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div>
            <h1>Accessibility report</h1>
            <a className="scanned-url" href={audit.finalUrl} target="_blank" rel="noreferrer">{audit.finalUrl} <span aria-hidden="true">↗</span></a>
          </div>
          <div className="report-actions"><button onClick={() => window.print()}>Print report</button><Link href="/">Scan another page <span aria-hidden="true">→</span></Link></div>
        </section>

        {audit.prototype && (
          <div className="prototype-banner" role="note">
            <span aria-hidden="true">◇</span>
            <p><b>Interactive product preview</b> — this report uses representative axe-core findings while the isolated browser worker is connected.</p>
          </div>
        )}

        <section className="report-summary" aria-label="Scan summary">
          <div className="summary-count"><strong>{audit.findings.length}</strong><span>Affected<br />rules</span></div>
          <div className="summary-count"><strong>{totalElements}</strong><span>Affected<br />elements</span></div>
          <div className="summary-severities">
            {(["critical", "serious", "moderate"] as Impact[]).map((impact) => (
              <span key={impact}><i className={impact} /> <b>{impactCounts[impact] || 0}</b> {impact}</span>
            ))}
          </div>
          <div className="scan-meta"><span>Viewport <b>1440 × 900</b></span><span>Standard <b>WCAG 2.2 A/AA</b></span></div>
        </section>

        <section className="report-content">
          <div className="findings-header">
            <div><span className="section-kicker">DETECTABLE ISSUES</span><h2>Findings</h2></div>
            <div className="filters" aria-label="Filter by impact">
              {FILTERS.map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? `All ${audit.findings.length}` : item}</button>)}
            </div>
          </div>

          <div className="findings-stack">
            {visibleFindings.map((finding, index) => (
              <details className={`finding-card impact-${finding.impact}`} key={finding.ruleId} open={index === 0 && filter === "all"}>
                <summary>
                  <span className={`severity-symbol ${finding.impact}-bg`}>!</span>
                  <span className="finding-title"><b>{finding.title}</b><small>{finding.count} affected {finding.count === 1 ? "element" : "elements"} · {finding.ruleId}</small></span>
                  <span className={`impact ${finding.impact}-text`}>{finding.impact}</span>
                  <span className="chevron" aria-hidden="true">⌄</span>
                </summary>
                <div className="finding-detail">
                  <div className="finding-explanation">
                    <p>{finding.explanation}</p>
                    <div className="wcag-links"><span>WCAG references</span>{finding.wcag.map((item) => <a key={item.label} href={item.href} target="_blank" rel="noreferrer">{item.label} ↗</a>)}</div>
                  </div>

                  <div className="occurrences-block">
                    <div className="subheading"><h3>Evidence</h3><span>Showing {finding.occurrences.length} of {finding.count}</span></div>
                    {finding.occurrences.map((occurrence, occurrenceIndex) => {
                      const key = `${finding.ruleId}-${occurrenceIndex}`;
                      return (
                        <div className="occurrence" key={occurrence.selector}>
                          <div className="occurrence-top"><span>Element {occurrenceIndex + 1}</span><code>{occurrence.selector}</code></div>
                          <div className="code-block"><code>{occurrence.html}</code><button aria-label="Copy HTML snippet" onClick={() => copyCode(key, occurrence.html)}>{copied === key ? "Copied" : "Copy"}</button></div>
                          <p><b>Why it failed:</b> {occurrence.failure}</p>
                        </div>
                      );
                    })}
                  </div>

                  <div className="ai-fix">
                    <div className="ai-fix-head"><span className="ai-badge"><i>✦</i> AI-assisted fix</span><span className={`confidence confidence-${finding.fix.confidence}`}>{finding.fix.confidence} confidence</span></div>
                    <h3>{finding.fix.summary}</h3>
                    <p>{finding.fix.whyItMatters}</p>
                    <ol>{finding.fix.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                    {finding.fix.codeExample && <div className="fix-code"><div><span>Suggested example</span><span>HTML / CSS</span></div><pre><code>{finding.fix.codeExample}</code></pre><button onClick={() => copyCode(`${finding.ruleId}-fix`, finding.fix.codeExample || "")}>{copied === `${finding.ruleId}-fix` ? "Copied" : "Copy example"}</button></div>}
                    {finding.fix.requiresManualReview && <div className="review-note"><span aria-hidden="true">!</span><p><b>Manual review required.</b> Confirm this fix matches the element’s purpose and test it with assistive technology.</p></div>}
                  </div>
                </div>
              </details>
            ))}
            {visibleFindings.length === 0 && <div className="empty-filter"><b>No {filter} findings</b><span>Try another impact filter.</span></div>}
          </div>
        </section>

        <section className="report-disclaimer">
          <span aria-hidden="true">◎</span><div><b>This is an automated first pass.</b><p>This scan identifies detectable issues in one rendered desktop page state. It is not a WCAG compliance certification and does not replace manual testing.</p></div>
        </section>
      </div>
      <footer className="report-footer"><span>Clarity</span><p>axe-core checks · WCAG 2.2 · Results expire after 7 days</p></footer>
    </main>
  );
}
