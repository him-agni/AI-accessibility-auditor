# Clarity — Project Handoff

Last updated: August 4, 2026 — audit fixes applied, hosting migrated to Cloudflare Workers

This is the living source of truth for the Clarity accessibility-scanner project. Update it whenever product behavior, architecture, deployment, data, security, or priorities change.

## Current state

Clarity is a polished, responsive web product that accepts one public webpage URL and presents a grouped accessibility report with evidence, WCAG references, impact levels, and cautious AI-assisted fix examples.

The current hosted release is an **interactive product preview**. It exercises the complete submission, progress, persistence, and report experience, but uses representative axe-core findings. A separate isolated Playwright/Chromium/axe-core worker is still required before results can be described as scans of the submitted page.

Remediations are no longer preview content: a real schema-validated model call now generates them, behind a provider-neutral interface, from whatever findings the pipeline supplies. The findings are still representative; the fix generation is real.

Do not remove or obscure the in-product preview notice until that production scanner is connected and verified.

On August 4, 2026 an audit pass fixed several defects and hosting moved from OpenAI Sites to Cloudflare Workers. See "Recent decisions".

## Hosting

Hosting is **Cloudflare Workers**, deployed with Wrangler. `wrangler.jsonc` at the repository root is the single source of bindings: the Vite plugin and `wrangler deploy` read the same file, so local dev and production cannot drift.

- Bindings: `DB` (D1), `ASSETS` (static assets), `IMAGES` (Cloudflare Images, backs `/_vinext/image` only)
- Deploy: `npm run deploy` — builds, then deploys `dist/server/wrangler.json`, the config Vite emits with bindings resolved
- Migrations: `npm run db:migrate` (remote) / `npm run db:migrate:local`
- Secrets: `wrangler secret put GEMINI_API_KEY`; locally, the gitignored `.dev.vars`

**Not yet done — required before the first deploy:**

1. `wrangler d1 create clarity-accessibility-scanner`, then paste the returned id over the placeholder `database_id` in `wrangler.jsonc`. The placeholder is `00000000-0000-4000-8000-000000000000`; local dev and the test suite do not need a real one.
2. Run `npm run db:migrate`.
3. Set `GEMINI_API_KEY` as a Worker secret if model-generated fixes are wanted.
4. Attach a domain. The previous OpenAI Sites URL (`clarity-accessibility-scanner.anuj-agrawal-2732.chatgpt.site`) and its ChatGPT sign-in gate are **gone** with the migration — there is currently no owner-only access control. If the deployment should stay private, add Cloudflare Access in front of it before pointing a domain at it.

`npm run deploy -- --dry-run` was run and passes: it resolves `env.DB`, `env.IMAGES`, and `env.ASSETS`. A real deploy has not been performed and needs the D1 id above.

No source credentials, access tokens, bypass tokens, API keys, or other secrets should ever be added to this document or committed to the repository.

## Product behavior

### Landing page

- Explains the one-page accessibility scan clearly.
- Accepts complete public HTTP or HTTPS URLs.
- Rejects malformed URLs and URLs containing credentials.
- States that automated scanning is not WCAG certification.
- Includes responsive layouts, reduced-motion support, and keyboard-accessible form controls.
- **Caveat:** it describes the browser-rendering pipeline in the present tense, which the preview does not yet do. See "Honesty gaps" below.

### Submission flow

- `POST /api/audits` validates and normalizes the submitted URL.
- Obvious local, private, link-local, multicast, and reserved destinations are rejected — with the exceptions recorded under "Security status".
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
- Hosting: Cloudflare Workers via Wrangler (`wrangler.jsonc`)
- Fix generation: Google Gemini via the Generative Language REST API, called with plain `fetch` (no SDK) so it runs inside the Worker

**There is no OpenAI dependency of any kind.** Gemini is the only model provider, and no `openai` package has ever been installed. The `.openai/` directory that used to sit at the root was OpenAI *Sites hosting* configuration, unrelated to models; it was removed on August 4 along with `build/sites-vite-plugin.ts` when hosting moved to Cloudflare Workers.

Important files:

- `wrangler.jsonc` — Cloudflare bindings, read by both the Vite plugin and `wrangler deploy`

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

Removed on August 4 as unused scaffold: `app/chatgpt-auth.ts`, `public/file.svg`, `public/globe.svg`, `public/window.svg`. A test now asserts they stay deleted. Note that `app/chatgpt-auth.ts` was the only thing that could have gated access by ChatGPT identity — see the access-control note under "Hosting".

## Data model

The intended normalized model contains:

- `audits`
- `issue_groups`
- `occurrences`
- `fix_suggestions`

The current preview runtime initializes and writes the `audits` table and stores representative findings in `report_json`. The remaining normalized tables are defined and migrated for the production worker integration. When the real scanner is connected, write normalized results into those tables and stop treating `report_json` as the primary report store.

Audit records include a seven-day expiry timestamp. Expired records are excluded from reads, but a scheduled physical-deletion job has not been added yet.

Generated remediations currently live inside `report_json` alongside their findings, and each one carries `provider`, `model`, and `promptVersion` so any report can say where its guidance came from. The `fix_suggestions` table already has those columns; move to it when the scanner writes normalized results.

Statuses are `queued | running | generating | completed | failed`. `generating` was missing from the `db/schema.ts` enum until August 4; it is now declared. No migration was needed — Drizzle emits no `CHECK` constraint for a text enum, so this was a type-level fix only.

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
- 2048-character URL length cap
- Hostname and literal-IP blocking for private destinations, including IPv6 unique-local, link-local, IPv4-mapped, and NAT64-embedded forms
- Hashed request fingerprinting (SHA-256 of `cf-connecting-ip`)
- Anonymous submission rate limiting
- No forwarding of user cookies or credentials
- No storage of complete target-page HTML

### `isBlockedHostname` — two defects fixed August 4, 2026

Both were found by direct probe during the audit. No SSRF surface existed, because the Worker never fetches the submitted URL, but this is the exact function the scanner will inherit.

1. **Every unique-local address was allowed through.** The ULA test was `/^f[cd][0-9a-f]:/i` — three hex digits then a colon — but real ULA prefixes are four wide (`fc00:`), so the branch never fired for anything in `fc00::/7`. Now `/^f[cd][0-9a-f]{2}:/i`. The neighbouring link-local test `/^fe[89ab][0-9a-f]:/i` was always correct, since `fe80` happens to be four characters, which is why link-local blocking worked and this went unnoticed.
2. **IPv4-mapped and NAT64-embedded IPv6 were never decoded.** `new URL()` re-renders `::ffff:127.0.0.1` as `::ffff:7f00:1`, so the dotted-quad branch never saw it. `EMBEDDED_IPV4` now decodes the trailing hex groups back to an address before the IPv4 rules run.

Regression tests cover both, plus `::1`, `fe80::`, loopback, RFC1918, and cloud metadata. Decimal (`http://2130706433`), octal (`0177.0.0.1`), and trailing-dot (`127.0.0.1.`) forms were never a problem — WHATWG `new URL()` normalizes them to dotted-quad before the guard runs — and are asserted anyway.

### Required before real public scanning

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

Re-run on August 4, 2026 after the cleanups and the hosting migration:

| Gate | Command | Result |
| --- | --- | --- |
| Production build | `npm run build` | pass — 5/5 environments |
| Type check | `npx tsc --noEmit` | pass — no errors |
| Lint | `npm run lint` | pass — no warnings |
| Tests | `npm test` | pass — 17/17 (was 10) |
| Deploy config | `npm run deploy -- --dry-run` | pass — resolves `DB`, `IMAGES`, `ASSETS` |

Coverage now spans fix generation (no-key fallback, one-request-per-audit, provenance, always-manual-review rules, per-group degradation, HTTP/timeout/network failure, fence stripping, single-poller claiming, stored-report replay) and, new on August 4, the worker controls this document describes as security features: the URL guard across 22 rejected and 5 accepted targets, the three-per-hour rate limit including window expiry, the seven-day expiry read filter, and both sides of the stranded-`generating` sweep. Plus the rendered-product smoke tests and a check that `wrangler.jsonc` declares the bindings and carries no key.

A real deploy has not been performed — it needs the D1 database id. Browser screenshot and visual-regression testing were not requested and are not release gates.

## Honesty gaps — closed August 4, 2026

Clarity's central product claim is that it never overstates what it did. Three places overstated it; all three are fixed.

1. `app/page.tsx` described the pipeline in the present tense while the preview does none of it, and carried no preview notice — the notice appeared only on the report page. The landing page now shows the same preview notice in the hero, the three step cards read in the future tense, and the viewport claim is qualified with "once scanning is live". **When the real scanner ships, move the step copy back to the present tense in that same change.**
2. `app/components/AuditReport.tsx` claimed "Isolated browser session" and showed progress steps reading "Browser launched" and "Running accessibility checks" while nothing was launched or checked. The steps now describe what actually happens — queueing, collecting findings, writing remediations — and the header reads "Product preview".
3. The report banner said findings are not a scan of this page "**while**" the browser worker is connected, close to the opposite of what was meant. It now reads "**until**".

## Known limitations

1. Submitted pages are not yet rendered by Playwright or scanned with axe-core.
2. Report findings are representative and intentionally labeled as a preview. Remediations generated from them are real, which means real model output about a page that was never visited — the preview notice carries this and must stay.
3. The Gemini path has not been exercised against the live API; it is verified only against a stubbed endpoint. Confirm with a real key before relying on it.
4. DNS rebinding and subresource protections require the isolated worker boundary.
5. No queue or retry dashboard yet. Worker observability is now enabled in `wrangler.jsonc`.
6. No scheduled cleanup physically deletes expired audits. A Workers cron trigger is the natural home for this.
7. **There is no access control on the deployment.** The ChatGPT sign-in gate went away with OpenAI Sites. Put Cloudflare Access in front of the Worker before attaching a public domain, if it should stay private.
8. The product intentionally excludes crawling, authentication, mobile viewports, screenshots, keyboard simulation, screen-reader testing, histories, billing, and automated code changes.

Fixed on August 4, previously listed here: an audit stranded in `generating` polled forever. The completion transition is claimed with a conditional `UPDATE`, and if the isolate died mid-generation nothing re-drove it; the client capped only *consecutive network errors*, so a well-formed `generating` response looped indefinitely. There is now a server-side sweep that reclaims a claim older than `GENERATION_STALE_MS` (45s past the generation point) and fails the audit, plus a `MAX_POLL_MS` wall-clock ceiling on the client. Both directions are tested. The sweep reuses `created_at` rather than adding a `generating_at` column, so no migration was needed; if the preview pacing constants change, re-check that arithmetic.

## Recommended next build

Finish the hosting cutover first — it is four commands, listed under "Hosting": create the D1 database, paste its id into `wrangler.jsonc`, run the migrations, set the Gemini secret. Then decide on Cloudflare Access before attaching a domain.

Then the real scanner vertical slice, unchanged:

1. Create a separately deployable Node worker with Playwright, Chromium, and axe-core.
2. Add public-destination validation that covers DNS, redirects, and subresources.
3. Connect the web submission API to a queue instead of preview completion timing.
4. Normalize axe results into `issue_groups` and `occurrences`.
5. Return those persisted results through the existing report API shape.
6. Replace the preview banner only after fixture and security tests pass.
7. ~~Add one schema-validated fix-generator provider behind a provider-neutral interface.~~ Done, August 3, 2026 — `lib/fixes` with a Gemini implementation. Point it at real axe output; no interface change needed.

## Product decisions to preserve

- Describe Clarity as an **AI-assisted accessibility scanner**, not a complete auditor.
- Never describe automated results as certification or conformance proof.
- Generate at most one remediation per rule group, not per affected element.
- Prefer deterministic axe and WCAG guidance before model-generated text.
- Mark uncertain fixes for manual review.
- Missing alt text normally requires human judgment unless image purpose is available.
- Keep the first release to one public page and one desktop viewport.
- Do not introduce a numerical "WCAG score."

## Maintenance checklist

For every future change:

1. Update the "Last updated" date.
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
- August 3, 2026 — Connected Gemini as the first real fix-generation provider, behind `lib/fixes`. Chose one request per audit over one per rule group to fit free-tier quota, and made deterministic guidance the guaranteed floor rather than a temporary stand-in.
- August 3, 2026 — Removed the client-side fallback that rendered example findings as a completed scan whenever the report API failed. A failed scan now says so. Fabricating a result on error contradicted the product's central claim.
- August 3, 2026 — Deduplicated the representative findings, which existed as two drifting copies in the Worker and the report component.
- August 4, 2026 — Full verification pass. All four gates passed. Found and recorded the `isBlockedHostname` ULA regex defect and IPv6 decoding gaps, the `status` enum drift, the stranded-`generating` polling loop, and the landing-page honesty gaps.
- August 4, 2026 — Fixed all of the above and covered each with a test. Suite went from 10 to 17. The URL guard, rate limit, and expiry filter now have coverage; their absence is why the guard defects went unnoticed for as long as they did.
- August 4, 2026 — Migrated hosting from OpenAI Sites to Cloudflare Workers. Removed `.openai/hosting.json`, `build/sites-vite-plugin.ts`, and the dead `app/chatgpt-auth.ts` scaffold; added `wrangler.jsonc` as the single source of bindings for both the Vite plugin and `wrangler deploy`. Chose one root config over separate dev and deploy configs specifically so the two cannot drift. Two consequences to keep visible: the `chatgpt.site` URL is gone, and with it the only access gate the product had.
- August 4, 2026 — Recorded explicitly that Gemini is the sole model provider and that no OpenAI dependency has ever existed. The `.openai/` directory was hosting configuration, not a model provider, and its name caused exactly the confusion the note now prevents.
