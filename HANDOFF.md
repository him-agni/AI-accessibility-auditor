# Clarity — Project Handoff

Last updated: August 28, 2026 — the real scanner is connected; this is no longer a preview

This is the living source of truth for the Clarity accessibility-scanner project. Update it whenever product behavior, architecture, deployment, data, security, or priorities change.

## Current state

Clarity is a polished, responsive web product that accepts one public webpage URL and presents a grouped accessibility report with evidence, WCAG references, impact levels, and cautious AI-assisted fix examples.

**The product really scans the submitted page.** Cloudflare Browser Rendering opens the URL in a real headless Chromium, axe-core runs against the rendered DOM, and the violations it reports are grouped into the report. Remediations are generated from those real findings by a schema-validated model call behind a provider-neutral interface.

Nothing in the product is representative content any more. The preview notices, the `prototype` response flag, and `lib/findings/representative.ts` were all removed on August 28, 2026 in the same change that connected the scanner. **Do not reintroduce fabricated findings under any circumstance** — if a scan cannot run, the audit fails and says so.

On August 4, 2026 an audit pass fixed several defects and hosting moved from OpenAI Sites to Cloudflare Workers. See "Recent decisions".

## Hosting

Hosting is **Cloudflare Workers**, deployed with Wrangler. `wrangler.jsonc` at the repository root is the single source of bindings: the Vite plugin and `wrangler deploy` read the same file, so local dev and production cannot drift.

- Bindings: `DB` (D1), `BROWSER` (Browser Rendering — this is what scans), `ASSETS` (static assets), `IMAGES` (Cloudflare Images, backs `/_vinext/image` only)
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
- Scanning: Cloudflare Browser Rendering (`@cloudflare/puppeteer`) driving headless Chromium, with `axe-core` injected into the page
- Fix generation: Google Gemini via the Generative Language REST API, called with plain `fetch` (no SDK) so it runs inside the Worker

### Findings have a kind and a detector

Every finding carries two fields, and the report treats them as load-bearing:

- `kind` — `violation` (maps to a WCAG 2.x A/AA success criterion) or `advisory` (axe best-practice; good hygiene, not a failure). **Only violations count toward the headline totals or the impact filters.** Advisories render in a separate, visually subordinate section that states plainly that they are not WCAG failures.
- `detector` — `axe` today. `heuristic` (our own browser-driven checks) and `ai` (model-suggested, never asserted as measured fact) are the planned additions, and the report must keep them distinguishable from what axe actually measured.

This split is the thing that makes it safe to add non-axe checks later. Without it, a heuristic guess and an axe measurement would look identical in the report, which is the failure mode this product exists to avoid. Do not collapse these fields, and do not let an advisory or a future AI suggestion into the headline numbers.

axe runs with `best-practice` alongside the WCAG tags, so all 105 of its rules execute; `normalize` splits them by tag. Group counts are capped per kind (25 violations, 15 advisories) so a flood of advisories can never push a real failure out of the report.

Advisories deliberately **do not go to the model**. They are lower stakes and more numerous, and including them would grow the prompt without changing what a team fixes first, so they always take deterministic guidance. An audit therefore stays at exactly one model request no matter how many best-practice notes a page produces.

### What a scan does, in order

1. **Desktop axe pass** at 1440×900 — the product's floor.
2. **Keyboard walk** (`lib/scan/keyboard.ts`) — presses Tab for real, up to 60 times, recording where focus lands, then re-focuses each visited element to see whether its appearance changes at all. Produces `keyboard-trap`, `keyboard-trap-cycle`, `focus-on-hidden-element`, `focus-not-visible` (all violations) and `focus-order-jumps` (advisory). Runs before any resize so recorded positions match the desktop layout.
3. **Mobile axe pass** at 390×844, merged with the desktop pass by rule id. A rule seen at both keeps the **higher** count, never the sum — they are two measurements of one page. Each finding carries `context`: "Desktop", "Mobile only", or "Desktop and mobile".
4. **Reflow measurement** at 320 CSS px (`lib/scan/viewport.ts`) — the width a 1280px viewport reaches at 400% zoom. Horizontal overflow beyond an 8px scrollbar tolerance is a WCAG 1.4.10 violation, naming the outermost offending element.

**Steps 2–4 are strictly best-effort.** Each has its own 20s budget, and a pass that throws or times out contributes nothing and logs why. The desktop axe results must never be lost because an extra check misbehaved — that is the whole reason they are separate passes rather than inline.

Because a caught error and a clean page both produce zero findings, every scan logs what each pass actually did:

```
axe 6 rules desktop / 9 mobile | keyboard 60 stops of 1387 focusable | reflow 1187px in 320px
```

Without that line a silently broken detector is indistinguishable from a page with nothing wrong. Keep it.

### How a scan runs

`POST /api/audits` validates the URL, stores a `queued` row, answers `202`, and starts the job with `ctx.waitUntil` — so the submission returns immediately and the client polls a real job rather than a timer. The job walks `queued → running → generating → completed`, or to `failed` with a stable `error_code`. Because the job lives in `waitUntil`, nothing re-drives it if that isolate is evicted; a reader retires any audit still non-terminal after `JOB_STALE_MS` (150s).

axe-core is bundled as a string (`axe-core/axe.min.js?raw`) and injected into the page. It never executes inside the Worker — only in the isolated browser tab.

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
- `lib/scan/index.ts` — the browser scan: navigation, request interception, redirect revalidation, axe injection, timeouts
- `lib/scan/normalize.ts` — axe violations mapped onto the report shape, with all the bounds
- `db/schema.ts` — normalized audit, issue-group, occurrence, and fix-suggestion models
- `drizzle/` — generated D1 migrations packaged for hosting
- `tests/rendered-html.test.mjs` — rendered-product smoke tests and deploy-config assertions
- `tests/fix-provider.test.mjs` — HTTP contract against the built Worker bundle, plus fix-provider behaviour
- `tests/normalize.test.mjs` — the axe-to-report mapping
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

Re-run on August 28, 2026 after connecting the scanner:

| Gate | Command | Result |
| --- | --- | --- |
| Production build | `npm run build` | pass — 5/5 environments |
| Type check | `npx tsc --noEmit` | pass — no errors |
| Lint | `npm run lint` | pass — no warnings |
| Tests | `npm test` | pass — 48/48 (was 33) |
| Deploy config | `npm run deploy -- --dry-run` | pass — resolves `DB`, `IMAGES`, `ASSETS` |

**Live scans verified against real pages** through `wrangler dev`, which runs a real local Chromium:

| Page | Outcome |
| --- | --- |
| `news.ycombinator.com` | 5 violations — `image-alt` ×3, `label` ×1, `color-contrast` ×238, `target-size` ×29, `link-name` ×1 — plus 3 advisories (`landmark-one-main`, `page-has-heading-one`, `region`), with real selectors and markup |
| `example.com` | completed, 0 findings — genuinely clean, title "Example Domain" read from the live DOM |
| `wikipedia.org` | completed, 0 findings |
| `w3.org/WAI/demos/bad/…` | failed with "The page returned HTTP 403" — the site blocked the request, reported honestly |
| `en.wikipedia.org` (wide table) | all three heuristics fired: reflow `1187px in 320px` blaming `thead`; `focus-on-hidden-element` ×6 on Vector's CSS-only dropdown checkboxes; `focus-order-jumps` ×3 as advisory |
| `bbc.com/news`, `arxiv.org`, `info.cern.ch` | scanned clean of heuristic findings — the detectors stay silent on well-built pages rather than manufacturing noise |

`target-size` appearing confirms the WCAG 2.2 AA tag set is active. The three-per-hour rate limit fired mid-testing, which was its own confirmation.

Coverage spans the HTTP contract (URL guard across 22 rejected and 5 accepted targets, rate limit including window expiry, expiry filter, staleness sweep, stored-report replay, and that a missing browser binding fails rather than fabricates), the axe-to-report mapping (bounds, ordering, WCAG tag derivation, malformed input, `javascript:` href rejection), and fix generation (no-key fallback, one-request-per-audit, provenance, always-manual-review rules, per-group degradation, HTTP/timeout/network failure, fence stripping).

Not yet verified: a real deploy, and the remote Browser Rendering service. Browser screenshot and visual-regression testing were not requested and are not release gates.

## Honesty gaps — closed August 4, 2026

Clarity's central product claim is that it never overstates what it did. Three places overstated it; all three are fixed.

1. `app/page.tsx` described the pipeline in the present tense while the preview does none of it, and carried no preview notice — the notice appeared only on the report page. The landing page now shows the same preview notice in the hero, the three step cards read in the future tense, and the viewport claim is qualified with "once scanning is live". **When the real scanner ships, move the step copy back to the present tense in that same change.**
2. `app/components/AuditReport.tsx` claimed "Isolated browser session" and showed progress steps reading "Browser launched" and "Running accessibility checks" while nothing was launched or checked. The steps now describe what actually happens — queueing, collecting findings, writing remediations — and the header reads "Product preview".
3. The report banner said findings are not a scan of this page "**while**" the browser worker is connected, close to the opposite of what was meant. It now reads "**until**".

## Known limitations

1. **The scan has not been exercised against the deployed Browser Rendering service** — only against the local Chromium `wrangler dev` provides. Remote behaviour (cold starts, session acquisition, concurrency limits) is unverified. Confirm after the first deploy.
2. The Gemini path has not been exercised against the live API; it is verified only against a stubbed endpoint. Confirm with a real key before relying on it.
3. **DNS rebinding is not addressed.** Every request the page makes is re-validated by hostname (`page.on("request")`), and the landed URL is re-checked after redirects, but a hostname that resolves to a private address still passes — the guard never sees resolved IPs. Cloudflare's browser runs outside our network, which limits the blast radius, but this is the remaining gap in the URL-guard story.
4. Only one page state is scanned: aside from pressing Tab, there is no interaction, no scrolling, and no dismissing of cookie banners. A page that renders its real content only after consent will be scanned in its pre-consent state.
4a. The keyboard walk stops at 60 Tab presses, so on a large page it covers only the first 60 stops — Wikipedia has 1387 focusable elements. A trap past that point is not detected.
4b. The focus-indicator check compares computed styles on the element and its parent. An indicator drawn only via `::before`/`::after`, or on a distant ancestor, will be missed. It errs toward silence rather than false alarms.
4c. Reflow is measured from `documentElement.scrollWidth`. A page using `overflow-x: hidden` clips its overflow instead of scrolling, so the measurement reads clean even though content is cut off.
5. Some sites block automated browsers outright. The scan surfaces that as an honest `http_error` (a 403 from `w3.org` was seen during testing) rather than an empty report.
6. No queue or retry dashboard yet. Worker observability is enabled in `wrangler.jsonc`.
7. No scheduled cleanup physically deletes expired audits. A Workers cron trigger is the natural home for this.
8. **There is no access control on the deployment.** The ChatGPT sign-in gate went away with OpenAI Sites. Put Cloudflare Access in front of the Worker before attaching a public domain, if it should stay private.
9. Browser Rendering has a free-tier ceiling of 10 minutes of browser time per day and 3 concurrent browsers. At roughly 5–15s per scan that is comfortably above the three-per-hour submission limit, but it is a real ceiling — a busy day returns `browser_unavailable` failures, not fake results.
10. The product intentionally excludes crawling, authentication, mobile viewports, screenshots, keyboard simulation, screen-reader testing, histories, billing, and automated code changes.

## Recommended next build

Finish the hosting cutover first — it is four commands, listed under "Hosting": create the D1 database, paste its id into `wrangler.jsonc`, run the migrations, set the Gemini secret. Then decide on Cloudflare Access before attaching a domain.

The scanner milestone is done. What is left of it, and what came next:

1. ~~Create a separately deployable Node worker with Playwright, Chromium, and axe-core.~~ Superseded, August 28, 2026 — Cloudflare Browser Rendering gives a real Chromium inside the existing Worker, so there is no second service, no queue, and no sandboxing for us to own.
2. ~~Add public-destination validation that covers redirects and subresources.~~ Done — `page.on("request")` re-validates every request, and the landed URL is re-checked after redirects. **DNS resolution checks are still missing**; see limitation 3.
3. ~~Return persisted results through the existing report API shape.~~ Done.
4. ~~Replace the preview banner.~~ Done — the banner, the `prototype` flag, and the representative findings module are all gone.
5. ~~Add one schema-validated fix-generator provider behind a provider-neutral interface.~~ Done, August 3, 2026.
6. ~~Run axe's full rule set behind a violation/advisory split.~~ Done, September 2, 2026.
7. **Still open:** normalize results into `issue_groups` and `occurrences` rather than `report_json`. The tables and their migration exist and are unused.
8. **Still open:** a scheduled cleanup that physically deletes expired audits.

### Comprehensiveness roadmap

Agreed order for widening what the auditor detects. The `kind`/`detector` split above is the enabling change and is done, so each of these can land independently:

1. ~~Keyboard and focus walk.~~ Done, September 2, 2026.
2. ~~Second viewport and reflow.~~ Done, September 2, 2026. Text resize at 200% (SC 1.4.4) was **not** built — bumping font sizes and detecting clipping produces too many false positives to assert as a failure. The 320px reflow test covers the same ground more defensibly.
3. **Fake interactive elements** (`detector: heuristic`) — an element with a click listener but no role, no tabindex, and `cursor: pointer` is a button that assistive technology cannot see. Detect via CDP `DOMDebugger.getEventListeners`; the model only writes the suggested label.
4. **Static form-error plumbing** — `aria-describedby` wiring, `aria-live` regions, `aria-invalid`. **Do not submit forms on third-party sites** to observe dynamic errors: that can create accounts, send messages, or trigger purchases on pages we do not own. Static checks only.
5. **Accessible authentication (SC 3.3.8)** — paste blocked on password fields, missing `autocomplete="username"`/`"current-password"`, CAPTCHA present. Narrow, only fires on login pages, but nothing else reports it.
6. **Vision alt-text review** (`detector: ai`) — last, behind a flag. Judging whether alt text is *meaningful* is the biggest quality gap, but it breaks the one-request-per-audit budget, and `image-alt` is deliberately always-manual-review because alt quality is human judgement. Ship as suggestions in the advisory tier, never as violations.

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
- August 28, 2026 — **Connected the real scanner.** Chose Cloudflare Browser Rendering over the separately deployed Playwright service this document had specified since August 2. The original plan predated knowing that Browser Rendering gives a real Chromium inside the existing Worker: it removes a second deploy target, a queue, and the entire non-root-sandboxing and egress-restriction burden, all of which Cloudflare now owns. It also runs locally under `wrangler dev`, so the scanner is testable without an account.
- August 28, 2026 — Moved the audit job to `ctx.waitUntil` from the submission request, replacing the timer that faked progress. The client now polls a real job and mirrors its actual status. Deleted the preview notices, the `prototype` response flag, and `lib/findings/representative.ts` in the same change — representative findings had no remaining purpose, and leaving them would have left a path back to fabricated reports.
- August 28, 2026 — Kept "no browser binding" as a hard failure rather than a fallback to example data. This is the same decision as August 3's removal of the client-side fallback, and it is the one the product's central claim rests on.
- September 2, 2026 — Turned on axe's 30 `best-practice` rules, taking the scanner from 70 of 105 rules to all 105. Verified on `news.ycombinator.com`: three findings we had been blind to (`landmark-one-main`, `page-has-heading-one`, `region`) with the headline count unchanged.
- September 2, 2026 — Added `kind` and `detector` to every finding, and split the report into WCAG failures and advisory notes. Chose two fields over one because they are independent axes: a future heuristic check for keyboard traps would be `detector: heuristic` *and* `kind: violation` (WCAG 2.1.2), so collapsing them would force a wrong answer. Advisories are excluded from all headline numbers and from the model prompt.
- September 2, 2026 — Added the keyboard walk, the mobile axe pass, and the 320px reflow measurement. This reverses the standing "no keyboard simulation" scope decision, deliberately: whether a keyboard user can escape a widget, or see where they are, is the largest category axe structurally cannot reach, and it is only answerable by driving the browser.
- September 2, 2026 — Made the extra passes best-effort with their own budgets, and made every scan log what each pass did. A caught error and a clean page both yield zero findings; without the log line the two are indistinguishable, which would let a broken detector look like good news indefinitely.
- September 2, 2026 — Merged the two viewports by taking the higher element count per rule rather than the sum. Ten contrast failures at desktop and fourteen at mobile are one page measured twice, not twenty-four problems; summing them would inflate the only number the report leads with.
- September 2, 2026 — Filed tab-order reversals as `advisory`. Focus jumping up the page is often legitimate, and the reading order it implies is a judgement the scan cannot make. This is the first finding whose kind was chosen for honesty rather than severity, and it is the pattern later heuristics should follow.
