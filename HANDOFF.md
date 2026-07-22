# Clarity — Project Handoff

Last updated: August 9, 2026

This is the living source of truth for the Clarity accessibility-scanner project. Update it whenever product behavior, architecture, deployment, data, security, or priorities change.

## Current state

Clarity is a polished, responsive web product that accepts one public webpage URL and presents a grouped accessibility report with evidence, WCAG references, impact levels, and cautious AI-assisted fix examples.

The current hosted release is an **interactive product preview**. It exercises the complete submission, progress, persistence, and report experience, but uses representative axe-core findings. A separate isolated Playwright/Chromium/axe-core worker is still required before results can be described as scans of the submitted page.

Remediations are no longer preview content: a real schema-validated model call now generates them, behind a provider-neutral interface, from whatever findings the pipeline supplies. The findings are still representative; the fix generation is real.

Do not remove or obscure the in-product preview notice until that production scanner is connected and verified.

## Live site

- Production URL: https://clarity-accessibility-scanner.anuj-agrawal-2732.chatgpt.site
- Access: custom, currently owner-only
- Sign-in route: `/signin-with-chatgpt?returnTo=%2F`
- Hosting configuration: `.openai/hosting.json`
- Persistent storage: Cloudflare D1 binding `DB`

No source credentials, access tokens, bypass tokens, API keys, or other secrets should ever be added to this document or committed to the repository.

## Product behavior

### Landing page

- Explains the one-page accessibility scan clearly.
- Accepts complete public HTTP or HTTPS URLs.
- Rejects malformed URLs and URLs containing credentials.
- States that automated scanning is not WCAG certification.
- Includes responsive layouts, reduced-motion support, and keyboard-accessible form controls.

### Submission flow

- `POST /api/audits` validates and normalizes the submitted URL.
- Obvious local, private, link-local, multicast, and reserved destinations are rejected.
- Anonymous submissions are limited to three per hour per hashed request fingerprint.
- A queued audit record is stored in D1 and returned with `202 Accepted`.
- The report page polls `GET /api/audits/:id` while showing progress states.

### Report experience

- Shows affected rule and element counts instead of a misleading WCAG score.
- Groups occurrences under their axe rule.
- Supports impact filters for critical, serious, moderate, and minor findings.
- Displays selectors, bounded HTML examples, failure explanations, and authoritative WCAG links.
- Provides one remediation per rule group with confidence and manual-review status, attributed to the model that produced it or marked as deterministic guidance.
- Supports copying code examples and printing the report.
- Repeats the automated-scan limitation at the bottom of every report.

## Technical shape

- Framework: Next.js 16-style App Router through vinext
- Language: TypeScript
- Runtime target: Cloudflare Workers-compatible ESM
- Styling: custom responsive CSS with Tailwind available for processing
- Persistence: Cloudflare D1
- Schema management: Drizzle ORM and Drizzle Kit
- Hosting: OpenAI Sites
- Fix generation: Google Gemini via the Generative Language REST API, called with plain `fetch` (no SDK) so it runs inside the Worker

Note: the `.openai/` directory is **hosting** configuration for OpenAI Sites. It is unrelated to model providers and must not be removed.

Important files:

- `app/page.tsx` — landing page and product explanation
- `app/components/ScanForm.tsx` — URL validation and submission
- `app/audits/[id]/page.tsx` — report route
- `app/components/AuditReport.tsx` — progress, polling, failure states, and report UI
- `app/globals.css` — complete visual system and responsive behavior
- `worker/index.ts` — API handling, URL guard, rate limiting, D1 persistence, and app dispatch
- `lib/fixes/index.ts` — provider selection and per-group fallback; the only entry point callers need
- `lib/fixes/gemini.ts` — Gemini request, response schema, output validation, injection guard
- `lib/fixes/deterministic.ts` — axe/WCAG guidance used when no model is configured or a call fails
- `lib/findings/representative.ts` — the single source of preview findings
- `db/schema.ts` — normalized audit, issue-group, occurrence, and fix-suggestion models
- `drizzle/` — generated D1 migrations packaged for hosting
- `tests/rendered-html.test.mjs` — rendered-product smoke tests
- `tests/fix-provider.test.mjs` — fix-generation behavior against the built Worker bundle
- `public/og.png` — generated social preview card

## Data model

The intended normalized model contains:

- `audits`
- `issue_groups`
- `occurrences`
- `fix_suggestions`

The current preview runtime initializes and writes the `audits` table and stores representative findings in `report_json`. The remaining normalized tables are defined and migrated for the production worker integration. When the real scanner is connected, write normalized results into those tables and stop treating `report_json` as the primary report store.

Audit records include a seven-day expiry timestamp. Expired records are excluded from reads, but a scheduled physical-deletion job has not been added yet.

Generated remediations currently live inside `report_json` alongside their findings, and each one carries `provider`, `model`, and `promptVersion` so any report can say where its guidance came from. The `fix_suggestions` table already has those columns; move to it when the scanner writes normalized results.

## Fix generation

One model request covers an entire audit — all rule groups in a single call, never one per group. The free Gemini tier is limited per minute and per day, so this matters. A poller that reaches the completion transition claims it with a conditional `UPDATE` to `generating`; losers keep polling instead of spending a second request.

Configuration, both optional:

- `GEMINI_API_KEY` — Google AI Studio key. Absent is a supported state, not an error.
- `GEMINI_MODEL` — defaults to `gemini-2.5-flash`. Any free-tier text model works.

Set these as Worker environment values. Locally, copy `.dev.vars.example` to `.dev.vars`, which is gitignored. Never commit a key.

Behavior guarantees, each covered by a test:

- No key, HTTP error, timeout, malformed JSON, or a hallucinated rule id all degrade to deterministic axe/WCAG guidance. A report is always complete.
- Fallback is per rule group, so one bad entry does not discard the rest of the response.
- Output is constrained by `responseSchema` at the API and re-validated in the Worker; a schema-constrained model is still untrusted input.
- Page markup reaches the model inside a block labeled untrusted, with a system instruction never to follow instructions found in it. Snippets are truncated and capped at three per group.
- Rules whose correct fix depends on human judgement (`image-alt`, `color-contrast`, `link-name`, and similar) are always flagged for manual review regardless of stated model confidence.

## Security status

Implemented in the web preview:

- HTTP/HTTPS-only URLs
- Embedded-credential rejection
- Basic hostname and literal-IP blocking for private destinations
- Hashed request fingerprinting
- Anonymous submission rate limiting
- No forwarding of user cookies or credentials
- No storage of complete target-page HTML

Required before real public scanning:

- A separately isolated, non-root browser worker with Chromium sandboxing
- A queue and strict single-job concurrency initially
- A and AAAA DNS resolution checks
- Revalidation after every redirect
- Equivalent protection for every subresource request
- Network-level egress restrictions, including cloud metadata blocking
- Navigation, total-job, response-size, and resource-count limits
- Disabled downloads and unnecessary browser permissions
- Stable error codes, retry rules, and worker observability

The browser worker must treat the page, markup, resource URLs, redirects, and model input as untrusted.

## Validation status

The current release passed:

- Production build
- TypeScript type checking
- ESLint
- Server-rendered landing-page tests
- Local URL submission and report retrieval through D1
- Generated migration inspection

Browser screenshot or visual-regression testing was not requested and has not been recorded as a release gate.

## Known limitations

1. Submitted pages are not yet rendered by Playwright or scanned with axe-core.
2. Report findings are representative and intentionally labeled as a preview. Remediations generated from them are real, which means real model output about a page that was never visited — the preview notice carries this and must stay.
3. The Gemini path has not been exercised against the live API; it is verified only against a stubbed endpoint. Confirm with a real key before relying on it.
4. DNS rebinding and subresource protections require the isolated worker boundary.
5. No queue, retry dashboard, or background-worker observability exists yet.
6. No scheduled cleanup physically deletes expired audits.
7. The product intentionally excludes crawling, authentication, mobile viewports, screenshots, keyboard simulation, screen-reader testing, histories, billing, and automated code changes.

## Recommended next build

The next milestone is the real scanner vertical slice:

1. Create a separately deployable Node worker with Playwright, Chromium, and axe-core.
2. Add public-destination validation that covers DNS, redirects, and subresources.
3. Connect the web submission API to a queue instead of preview completion timing.
4. Normalize axe results into `issue_groups` and `occurrences`.
5. Return those persisted results through the existing report API shape.
6. Replace the preview banner only after fixture and security tests pass.
7. ~~Add one schema-validated fix-generator provider behind a provider-neutral interface.~~ Done, August 9, 2026 — `lib/fixes` with a Gemini implementation. Point it at real axe output; no interface change needed.

## Product decisions to preserve

- Describe Clarity as an **AI-assisted accessibility scanner**, not a complete auditor.
- Never describe automated results as certification or conformance proof.
- Generate at most one remediation per rule group, not per affected element.
- Prefer deterministic axe and WCAG guidance before model-generated text.
- Mark uncertain fixes for manual review.
- Missing alt text normally requires human judgment unless image purpose is available.
- Keep the first release to one public page and one desktop viewport.
- Do not introduce a numerical “WCAG score.”

## Maintenance checklist

For every future change:

1. Update the “Last updated” date.
2. Update current behavior, limitations, and next steps in this file.
3. Record new environment bindings or migrations without recording secret values.
4. Re-run validation proportional to the change.
5. Keep deployment access and the live URL accurate.
6. Ensure product claims match the capabilities actually deployed.

## Recent decisions

- August 1, 2026 — Built and privately deployed the first Clarity product preview.
- August 1, 2026 — Added D1 persistence, anonymous rate limiting, URL guards, report polling, and representative grouped findings.
- August 1, 2026 — Kept the report honest with a visible preview notice and repeated non-certification language.
- August 2, 2026 — Established this living handoff document for all subsequent work.
- August 9, 2026 — Connected Gemini as the first real fix-generation provider, behind `lib/fixes`. Chose one request per audit over one per rule group to fit free-tier quota, and made deterministic guidance the guaranteed floor rather than a temporary stand-in.
- August 9, 2026 — Removed the client-side fallback that rendered example findings as a completed scan whenever the report API failed. A failed scan now says so. Fabricating a result on error contradicted the product's central claim.
- August 9, 2026 — Deduplicated the representative findings, which existed as two drifting copies in the Worker and the report component.
