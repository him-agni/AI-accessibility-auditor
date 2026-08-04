import { ScanForm } from "./components/ScanForm";
import Link from "next/link";

// Written in the future tense on purpose: the isolated browser worker is not
// connected yet, so the product cannot claim it renders the submitted page today.
// Move these to the present tense in the same change that ships the real scanner.
const STEPS = [
  {
    number: "01",
    title: "We render the page",
    copy: "A fresh desktop browser will open the exact public URL you submit.",
  },
  {
    number: "02",
    title: "Axe checks the DOM",
    copy: "WCAG 2.2 A and AA checks will run against the page state we can see.",
  },
  {
    number: "03",
    title: "You get a clear report",
    copy: "Findings are grouped by rule with evidence and practical next steps.",
  },
];

export default function Home() {
  return (
    <main>
      <nav className="site-nav" aria-label="Main navigation">
        <Link className="brand" href="/" aria-label="Clarity home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Clarity</span>
        </Link>
        <div className="nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#scope">What we check</a>
          <a className="nav-cta" href="#scan">Scan a page</a>
        </div>
      </nav>

      <section className="hero" id="scan">
        <div className="eyebrow"><span className="pulse-dot" /> AI-assisted accessibility scanner</div>
        <h1>Catch accessibility<br />blockers <em>before</em> your users do.</h1>
        <p className="hero-copy">
          Paste a public webpage URL. Get a focused report of detectable WCAG issues,
          the elements affected, and practical ways to fix them.
        </p>
        <ScanForm />
        <div className="trust-row" aria-label="Product details">
          <span><b aria-hidden="true">✓</b> No account needed</span>
          <span><b aria-hidden="true">✓</b> One page at a time</span>
          <span><b aria-hidden="true">✓</b> Results expire in 7 days</span>
        </div>
        <div className="prototype-banner hero-preview-note" role="note">
          <span aria-hidden="true">◇</span>
          <p><b>Interactive product preview</b> — submitted pages are not rendered or scanned yet. Reports show representative axe-core findings, clearly labelled, until the isolated browser worker is connected. The fix suggestions are really generated.</p>
        </div>
      </section>

      <section className="report-preview" aria-label="Example accessibility report">
        <div className="preview-window">
          <div className="window-bar">
            <div className="window-dots" aria-hidden="true"><i /><i /><i /></div>
            <div className="fake-address"><span aria-hidden="true">↗</span> shop.example.com/products</div>
            <span className="window-tag">Example report</span>
          </div>
          <div className="preview-body">
            <aside className="preview-sidebar" aria-hidden="true">
              <span className="mini-brand"><i /> Clarity</span>
              <div className="side-line active" /><div className="side-line" /><div className="side-line short" />
            </aside>
            <div className="preview-report">
              <div className="preview-topline">
                <div><span className="tiny-kicker">SCAN COMPLETE</span><h2>Accessibility report</h2></div>
                <span className="status-pill">● Complete</span>
              </div>
              <div className="summary-strip">
                <div className="summary-main"><strong>5</strong><span>affected<br />rules</span></div>
                <div><strong>22</strong><span>affected<br />elements</span></div>
                <div className="severity-mini"><span><i className="critical" /> 1 critical</span><span><i className="serious" /> 3 serious</span><span><i className="moderate" /> 1 moderate</span></div>
              </div>
              <div className="finding-list">
                <div className="finding-row">
                  <span className="severity-symbol critical-bg">!</span>
                  <div><b>Buttons must have discernible text</b><small>2 elements · WCAG 4.1.2</small></div>
                  <span className="impact critical-text">Critical</span><span aria-hidden="true">⌄</span>
                </div>
                <div className="finding-row">
                  <span className="severity-symbol serious-bg">!</span>
                  <div><b>Elements must meet color contrast minimums</b><small>12 elements · WCAG 1.4.3</small></div>
                  <span className="impact serious-text">Serious</span><span aria-hidden="true">⌄</span>
                </div>
                <div className="finding-row">
                  <span className="severity-symbol serious-bg">!</span>
                  <div><b>Images must have alternative text</b><small>3 elements · WCAG 1.1.1</small></div>
                  <span className="impact serious-text">Serious</span><span aria-hidden="true">⌄</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="steps-section" id="how-it-works">
        <div className="section-heading">
          <span className="section-kicker">A SMALLER, SHARPER AUDIT</span>
          <h2>One page. One state.<br />A useful place to start.</h2>
          <p>Automated checks cannot prove WCAG conformance. They can give your team a fast, evidence-based first pass.</p>
        </div>
        <div className="steps-grid">
          {STEPS.map((step) => (
            <article className="step-card" key={step.number}>
              <span className="step-number">{step.number}</span>
              <div className={`step-visual visual-${step.number}`} aria-hidden="true">
                {step.number === "01" && <><i className="browser-frame" /><i className="cursor-shape">↖</i></>}
                {step.number === "02" && <><i className="scan-line" /><b>&lt;main&gt;</b><small>aria-label=&quot;Cart&quot;</small></>}
                {step.number === "03" && <><i className="report-sheet" /><i className="report-check">✓</i></>}
              </div>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="scope-section" id="scope">
        <div className="scope-callout">
          <span className="scope-icon" aria-hidden="true">◎</span>
          <div>
            <span className="section-kicker">HONEST BY DESIGN</span>
            <h2>A scan, not a certification.</h2>
          </div>
          <p>
            This automated scan identifies detectable issues in the page state tested.
            It does not replace expert review, keyboard testing, or evaluation with assistive technology.
          </p>
        </div>
        <div className="scope-grid">
          <div><b>Checks</b><span>WCAG 2.2 A &amp; AA rules supported by axe-core</span></div>
          <div><b>Viewport</b><span>Desktop Chromium at 1440 × 900, once scanning is live</span></div>
          <div><b>Evidence</b><span>Selectors, HTML snippets, and failure summaries</span></div>
          <div><b>Fixes</b><span>AI-assisted suggestions, clearly marked for review</span></div>
        </div>
      </section>

      <section className="final-cta">
        <span className="section-kicker">START WITH ONE PAGE</span>
        <h2>See what is getting<br />in your users&apos; way.</h2>
        <a href="#scan" className="button-primary">Scan a public webpage <span aria-hidden="true">→</span></a>
      </section>

      <footer>
        <Link className="brand footer-brand" href="/"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Clarity</span></Link>
        <p>Automated accessibility checks, explained clearly.</p>
        <span>Built with axe-core · WCAG 2.2</span>
      </footer>
    </main>
  );
}
