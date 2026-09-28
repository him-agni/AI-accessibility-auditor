import Link from "next/link";
import type { Progress } from "./useAuditPolling";

export function Brand() {
  return <Link className="brand" href="/"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Clarity</span></Link>;
}

const HEADLINES = {
  queued: "Getting the browser ready…",
  running: "Checking the rendered page…",
  generating: "Writing the remediations…",
};

/** The job's status as a position in STEPS: every earlier step is done, this one is active. */
const STAGE = { queued: 1, running: 2, generating: 3 };

const STEPS = ["URL validated", "Browser launched", "Running accessibility checks", "Grouping findings and writing fixes"];

function stepState(step: number, stage: number) {
  if (step < stage) return "done";
  return step === stage ? "active" : "";
}

/** Shown until the report is ready: live progress, or why the scan stopped. */
export function ScanProgress({ status, submittedUrl, failureMessage }: { status: Progress; submittedUrl: string; failureMessage: string }) {
  return (
    <main className="scan-progress-page">
      <header className="report-nav">
        <Brand />
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
          <h1>{HEADLINES[status]}</h1>
          <p className="progress-url">{submittedUrl}</p>
          <div className="progress-steps">
            {STEPS.map((label, step) => {
              const state = stepState(step, STAGE[status]);
              return <span key={label} className={state}><i>{state === "done" ? "✓" : step + 1}</i> {label}</span>;
            })}
          </div>
          <small>Most single-page scans finish in well under a minute.</small>
        </section>
      )}
    </main>
  );
}
