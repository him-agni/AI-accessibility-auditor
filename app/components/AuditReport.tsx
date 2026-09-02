"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Finding, Impact } from "../../lib/fixes";

type Audit = {
  id: string;
  url: string;
  finalUrl: string;
  pageTitle: string;
  status: "queued" | "running" | "generating" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  findings: Finding[];
  error?: string;
};

/** The non-terminal states the progress card renders, plus the local failure state. */
type Progress = "queued" | "running" | "generating" | "failed";

const FILTERS = ["all", "critical", "serious", "moderate", "minor"] as const;

const POLL_INTERVAL_MS = 1200;
const MAX_CONSECUTIVE_ERRORS = 4;
/**
 * Wall-clock ceiling. The error counter only catches a failing fetch; an audit stuck
 * in a non-terminal status answers every poll successfully and would loop forever.
 * Above the worker's own 150s staleness sweep, so the server normally resolves first.
 */
const MAX_POLL_MS = 180_000;

export function AuditReport({ auditId }: { auditId: string }) {
  const params = useSearchParams();
  const submittedUrl = params.get("url") || "";
  const [audit, setAudit] = useState<Audit | null>(null);
  const [status, setStatus] = useState<Progress>("queued");
  const [failureMessage, setFailureMessage] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let consecutiveErrors = 0;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();

    function fail(message: string) {
      setFailureMessage(message);
      setStatus("failed");
    }

    async function poll() {
      if (Date.now() - startedAt > MAX_POLL_MS) return fail("This scan did not finish in time. Try scanning this page again.");
      try {
        const response = await fetch(`/api/audits/${auditId}`, { cache: "no-store" });
        const result = await response.json() as Audit;
        if (cancelled) return;
        if (!response.ok) return fail(result.error || "This report is no longer available.");
        consecutiveErrors = 0;
        if (result.status === "completed") setAudit(result);
        else if (result.status === "failed") fail(result.error || "This page could not be scanned.");
        else {
          // Mirror the job's real status rather than guessing from attempt count.
          setStatus(result.status);
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        if (cancelled) return;
        // Transient network trouble is worth retrying; a persistent outage is not
        // worth faking a result for. Never substitute example data for a real scan.
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return fail("We lost contact with the scanner. Check your connection and try again.");
        timer = setTimeout(poll, POLL_INTERVAL_MS * consecutiveErrors);
      }
    }

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [auditId]);

  // Advisories are good practice, not WCAG failures. They are reported separately
  // and deliberately excluded from every headline number.
  const violations = useMemo(() => audit?.findings.filter((finding) => finding.kind !== "advisory") || [], [audit]);
  const advisories = useMemo(() => audit?.findings.filter((finding) => finding.kind === "advisory") || [], [audit]);
  const visibleFindings = useMemo(() => violations.filter((finding) => filter === "all" || finding.impact === filter), [violations, filter]);
  const totalElements = violations.reduce((sum, finding) => sum + finding.count, 0);
  const impactCounts = violations.reduce<Record<string, number>>((acc, finding) => ({ ...acc, [finding.impact]: (acc[finding.impact] || 0) + 1 }), {});

  async function copyCode(key: string, code: string) {
    await navigator.clipboard.writeText(code);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  /** One rule group. Shared by the violations list and the advisory list. */
  function renderFinding(finding: Finding, openByDefault: boolean) {
    const advisory = finding.kind === "advisory";
    return (
      <details className={`finding-card impact-${finding.impact}${advisory ? " advisory-card" : ""}`} key={finding.ruleId} open={openByDefault}>
        <summary>
          <span className={`severity-symbol ${advisory ? "advisory-bg" : `${finding.impact}-bg`}`}>{advisory ? "i" : "!"}</span>
          <span className="finding-title"><b>{finding.title}</b><small>{finding.count} affected {finding.count === 1 ? "element" : "elements"} · {finding.ruleId}</small></span>
          <span className={`impact ${advisory ? "advisory-text" : `${finding.impact}-text`}`}>{advisory ? "advisory" : finding.impact}</span>
          <span className="chevron" aria-hidden="true">⌄</span>
        </summary>
        <div className="finding-detail">
          <div className="finding-explanation">
            <p>{finding.explanation}</p>
            {finding.wcag.length > 0 && (
              <div className="wcag-links"><span>{advisory ? "Reference" : "WCAG references"}</span>{finding.wcag.map((item) => <a key={item.label} href={item.href} target="_blank" rel="noreferrer">{item.label} ↗</a>)}</div>
            )}
          </div>

          <div className="occurrences-block">
            <div className="subheading"><h3>Evidence</h3><span>Showing {finding.occurrences.length} of {finding.count}</span></div>
            {finding.occurrences.map((occurrence, occurrenceIndex) => {
              const key = `${finding.ruleId}-${occurrenceIndex}`;
              return (
                <div className="occurrence" key={occurrence.selector}>
                  <div className="occurrence-top"><span>Element {occurrenceIndex + 1}</span><code>{occurrence.selector}</code></div>
                  <div className="code-block"><code>{occurrence.html}</code><button aria-label="Copy HTML snippet" onClick={() => copyCode(key, occurrence.html)}>{copied === key ? "Copied" : "Copy"}</button></div>
                  <p><b>{advisory ? "What axe reported:" : "Why it failed:"}</b> {occurrence.failure}</p>
                </div>
              );
            })}
          </div>

          <div className="ai-fix">
            <div className="ai-fix-head"><span className="ai-badge"><i>✦</i> {finding.fix.provider && finding.fix.provider !== "deterministic" ? "AI-assisted fix" : "Standard guidance"}</span><span className={`confidence confidence-${finding.fix.confidence}`}>{finding.fix.confidence} confidence</span></div>
            <h3>{finding.fix.summary}</h3>
            <p>{finding.fix.whyItMatters}</p>
            <ol>{finding.fix.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            {finding.fix.codeExample && <div className="fix-code"><div><span>Suggested example</span><span>HTML / CSS</span></div><pre><code>{finding.fix.codeExample}</code></pre><button onClick={() => copyCode(`${finding.ruleId}-fix`, finding.fix.codeExample || "")}>{copied === `${finding.ruleId}-fix` ? "Copied" : "Copy example"}</button></div>}
            {finding.fix.requiresManualReview && <div className="review-note"><span aria-hidden="true">!</span><p><b>Manual review required.</b> Confirm this fix matches the element’s purpose and test it with assistive technology.</p></div>}
            {finding.fix.model && <p className="fix-provenance">{finding.fix.provider === "deterministic" ? "Deterministic axe and WCAG guidance — no model was used." : `Generated by ${finding.fix.model}. Always review before shipping.`}</p>}
          </div>
        </div>
      </details>
    );
  }

  if (!audit) {
    return (
      <main className="scan-progress-page">
        <header className="report-nav">
          <Link className="brand" href="/"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Clarity</span></Link>
          <span className="secure-note"><i /> Isolated browser session</span>
        </header>
        {status === "failed" ? (
          <section className="progress-card" aria-live="assertive">
            <span className="section-kicker">SCAN UNAVAILABLE</span>
            <h1>This page could not be scanned</h1>
            <p className="progress-url">{submittedUrl}</p>
            <p className="progress-failure">{failureMessage || "The scan did not finish."}</p>
            <Link className="button-primary" href="/">Start a new scan <span aria-hidden="true">→</span></Link>
          </section>
        ) : (
          <section className="progress-card" aria-live="polite">
            <div className="radar" aria-hidden="true"><i /><i /><i /><span /></div>
            <span className="section-kicker">SCAN IN PROGRESS</span>
            <h1>{status === "queued" ? "Getting the browser ready…" : status === "running" ? "Checking the rendered page…" : "Writing the remediations…"}</h1>
            <p className="progress-url">{submittedUrl}</p>
            <div className="progress-steps">
              <span className="done"><i>✓</i> URL validated</span>
              <span className={status === "queued" ? "active" : "done"}><i>{status === "queued" ? "2" : "✓"}</i> Browser launched</span>
              <span className={status === "running" ? "active" : status === "generating" ? "done" : ""}><i>{status === "generating" ? "✓" : "3"}</i> Running accessibility checks</span>
              <span className={status === "generating" ? "active" : ""}><i>4</i> Grouping findings and writing fixes</span>
            </div>
            <small>Most single-page scans finish in well under a minute.</small>
          </section>
        )}
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

        <section className="report-summary" aria-label="Scan summary">
          <div className="summary-count"><strong>{violations.length}</strong><span>Affected<br />rules</span></div>
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
            <div><span className="section-kicker">WCAG 2.2 A / AA FAILURES</span><h2>Findings</h2></div>
            <div className="filters" aria-label="Filter by impact">
              {FILTERS.map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? `All ${violations.length}` : item}</button>)}
            </div>
          </div>

          <div className="findings-stack">
            {visibleFindings.map((finding, index) => renderFinding(finding, index === 0 && filter === "all"))}
            {visibleFindings.length === 0 && (
              violations.length === 0
                // A genuinely clean scan is a real outcome now, not an empty filter.
                ? <div className="empty-filter clean-result"><b>No WCAG failures detected</b><span>axe-core found no WCAG 2.2 A or AA violations it can detect automatically on this page. That is not the same as being accessible — keyboard and assistive-technology testing are still required.{advisories.length > 0 ? ` ${advisories.length} best-practice ${advisories.length === 1 ? "note is" : "notes are"} listed below.` : ""}</span></div>
                : <div className="empty-filter"><b>No {filter} findings</b><span>Try another impact filter.</span></div>
            )}
          </div>
        </section>

        {advisories.length > 0 && (
          <section className="report-content advisory-section">
            <div className="findings-header">
              <div>
                <span className="section-kicker">BEST PRACTICE</span>
                <h2>Advisory notes</h2>
              </div>
              <span className="advisory-count">{advisories.length}</span>
            </div>
            <p className="advisory-lead">
              These are <b>not WCAG failures</b> and are excluded from the counts above. They are
              patterns that commonly cause problems for assistive technology — missing landmarks,
              skipped heading levels, positive <code>tabindex</code> — and are usually worth fixing
              once the failures above are resolved.
            </p>
            <div className="findings-stack">
              {advisories.map((finding) => renderFinding(finding, false))}
            </div>
          </section>
        )}

        <section className="report-disclaimer">
          <span aria-hidden="true">◎</span><div><b>This is an automated first pass.</b><p>This scan identifies detectable issues in one rendered desktop page state. It is not a WCAG compliance certification and does not replace manual testing.</p></div>
        </section>
      </div>
      <footer className="report-footer"><span>Clarity</span><p>axe-core checks · WCAG 2.2 · Results expire after 7 days</p></footer>
    </main>
  );
}
