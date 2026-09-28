"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Finding, Impact } from "../../lib/fixes";
import { FindingCard } from "./FindingCard";
import { Brand, ScanProgress } from "./ScanProgress";
import { useAuditPolling } from "./useAuditPolling";

const FILTERS = ["all", "critical", "serious", "moderate", "minor"] as const;
type Filter = (typeof FILTERS)[number];

const SUMMARY_IMPACTS: Impact[] = ["critical", "serious", "moderate"];

function countByImpact(findings: Finding[]) {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.impact] = (counts[finding.impact] || 0) + 1;
  return counts;
}

function EmptyFindings({ filter, violationCount, advisoryCount }: { filter: Filter; violationCount: number; advisoryCount: number }) {
  if (violationCount > 0) return <div className="empty-filter"><b>No {filter} findings</b><span>Try another impact filter.</span></div>;

  // A genuinely clean scan is a real outcome, not an empty filter.
  const advisoryNote = advisoryCount > 0 ? ` ${advisoryCount} best-practice ${advisoryCount === 1 ? "note is" : "notes are"} listed below.` : "";
  return <div className="empty-filter clean-result"><b>No WCAG failures detected</b><span>axe-core found no WCAG 2.2 A or AA violations it can detect automatically on this page. That is not the same as being accessible — keyboard and assistive-technology testing are still required.{advisoryNote}</span></div>;
}

export function AuditReport({ auditId }: { auditId: string }) {
  const submittedUrl = useSearchParams().get("url") || "";
  const { audit, status, failureMessage } = useAuditPolling(auditId);
  const [filter, setFilter] = useState<Filter>("all");

  // Advisories are good practice, not WCAG failures. They are reported separately
  // and deliberately excluded from every headline number.
  const violations = useMemo(() => audit?.findings.filter((finding) => finding.kind !== "advisory") || [], [audit]);
  const advisories = useMemo(() => audit?.findings.filter((finding) => finding.kind === "advisory") || [], [audit]);
  const visibleFindings = useMemo(() => violations.filter((finding) => filter === "all" || finding.impact === filter), [violations, filter]);
  const totalElements = violations.reduce((sum, finding) => sum + finding.count, 0);
  const impactCounts = countByImpact(violations);

  if (!audit) return <ScanProgress status={status} submittedUrl={submittedUrl} failureMessage={failureMessage} />;

  return (
    <main className="report-page">
      <header className="report-nav">
        <Brand />
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
            {SUMMARY_IMPACTS.map((impact) => (
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
            {visibleFindings.map((finding, index) => <FindingCard key={finding.ruleId} finding={finding} open={index === 0 && filter === "all"} />)}
            {visibleFindings.length === 0 && <EmptyFindings filter={filter} violationCount={violations.length} advisoryCount={advisories.length} />}
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
              {advisories.map((finding) => <FindingCard key={finding.ruleId} finding={finding} open={false} />)}
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
