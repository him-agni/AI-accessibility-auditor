import assert from "node:assert/strict";
import test from "node:test";

// Two surfaces are exercised here:
//  - the built Worker bundle, for the HTTP contract (validation, limits, lifecycle);
//  - the bundled `lib/fixes`, for provider behaviour, which no longer has a route
//    into the worker now that findings come from a real browser scan.
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-fix-provider`);
const { default: worker } = await import(workerUrl.href);
const { buildFindings, reviewAltText, altReviewEnabled } = await import("../dist/test/fixes/index.mjs");

const ASSETS = { fetch: async () => new Response("Not found", { status: 404 }) };
const originalFetch = globalThis.fetch;

const meta = (changes) => ({ results: [], success: true, meta: { changes, duration: 0, rows_read: 0, rows_written: changes } });

function createDatabase() {
  const rows = new Map();

  const statement = (sql, values) => ({
    bind: (...next) => statement(sql, next),
    async first() {
      if (/^SELECT COUNT/i.test(sql)) {
        const [fingerprint, since] = values;
        return { count: [...rows.values()].filter((row) => row.request_fingerprint === fingerprint && row.created_at > since).length };
      }
      if (/^SELECT id, submitted_url/i.test(sql)) {
        const [id, now] = values;
        const row = rows.get(id);
        return row && row.expires_at > now ? { ...row } : null;
      }
      throw new Error(`unexpected first(): ${sql}`);
    },
    async run() {
      if (/^CREATE /i.test(sql)) return meta(0);
      if (/^INSERT INTO audits/i.test(sql)) {
        const [id, submitted_url, request_fingerprint, created_at, expires_at] = values;
        rows.set(id, { id, submitted_url, final_url: null, status: "queued", page_title: null, report_json: null, error_message: null, completed_at: null, request_fingerprint, created_at, expires_at });
        return meta(1);
      }
      if (/SET status = 'running'/.test(sql)) {
        const [startedAt, id] = values;
        const row = rows.get(id);
        if (row?.status !== "queued") return meta(0);
        Object.assign(row, { status: "running", started_at: startedAt });
        return meta(1);
      }
      if (/SET status = 'generating'/.test(sql)) {
        const [final_url, page_title, axe_version, id] = values;
        const row = rows.get(id);
        if (!row) return meta(0);
        Object.assign(row, { status: "generating", final_url, page_title, axe_version });
        return meta(1);
      }
      if (/SET status = 'completed'/.test(sql)) {
        const [report_json, completed_at, id] = values;
        Object.assign(rows.get(id), { status: "completed", report_json, completed_at });
        return meta(1);
      }
      if (/SET status = 'failed'/.test(sql)) {
        const [error_code, error_message, completed_at, id] = values;
        const row = rows.get(id);
        // The staleness sweep guards on status; a terminal audit must not be reopened.
        if (/status NOT IN/.test(sql) && ["completed", "failed"].includes(row?.status)) return meta(0);
        Object.assign(row, { status: "failed", error_code, error_message, completed_at });
        return meta(1);
      }
      throw new Error(`unexpected run(): ${sql}`);
    },
  });

  return { rows, prepare: (sql) => statement(sql, []), batch: (statements) => Promise.all(statements.map((item) => item.run())) };
}

function createEnv(overrides = {}) {
  return { ASSETS, DB: createDatabase(), ...overrides };
}

/** Captures `waitUntil` work so a test can await the background audit job. */
function createContext() {
  const pending = [];
  return { ctx: { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} }, settled: () => Promise.allSettled(pending) };
}

async function call(env, path, init, ctx) {
  const context = ctx ?? createContext();
  const response = await worker.fetch(new Request(`http://localhost${path}`, init), env, context.ctx ?? context);
  return { response, settled: context.settled ?? (() => Promise.resolve()) };
}

const post = (env, url, ctx) => call(env, "/api/audits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }, ctx);

async function submit(env, url = "https://example.com/products") {
  const context = createContext();
  const { response } = await post(env, url, context);
  assert.equal(response.status, 202);
  const { id } = await response.json();
  // Let the background job run to completion before the test inspects state.
  await context.settled();
  return id;
}

const get = async (env, id) => (await call(env, `/api/audits/${id}`)).response;

function stubGemini(handler) {
  globalThis.fetch = async (input, init) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes("generativelanguage.googleapis.com")) return handler(target, init);
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

const geminiOk = (body) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });

const finding = (overrides = {}) => ({
  ruleId: "button-name",
  kind: "violation",
  detector: "axe",
  impact: "critical",
  title: "Buttons must have discernible text",
  explanation: "Icon-only buttons have no accessible name.",
  wcag: [{ label: "4.1.2 (WCAG)", href: "https://www.w3.org/WAI/WCAG22/quickref/#criterion-4.1.2" }],
  count: 2,
  occurrences: [{ selector: "button.cart", html: "<button class=\"cart\"></button>", failure: "No accessible name." }],
  ...overrides,
});

const SAMPLE = [finding(), finding({ ruleId: "image-alt", impact: "serious" }), finding({ ruleId: "html-has-lang", impact: "moderate" })];
const fixFor = (findings, ruleId) => findings.find((item) => item.ruleId === ruleId).fix;

// ---------------------------------------------------------------- HTTP contract

test("rejects non-public and malformed submission targets", async () => {
  const rejected = [
    "not-a-url",
    "ftp://example.com/page",
    "file:///etc/passwd",
    "https://user:secret@example.com/page",
    "http://localhost:3000/",
    "http://app.internal/",
    "http://dev.local/",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.4.2/",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://2130706433/",                       // decimal loopback
    "http://0177.0.0.1/",                       // octal loopback
    "http://127.0.0.1./",                       // trailing dot
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",                        // unique-local
    "http://[::ffff:127.0.0.1]/",               // IPv4-mapped loopback
    "http://[::ffff:10.0.0.1]/",                // IPv4-mapped private
    "http://[64:ff9b::127.0.0.1]/",             // NAT64-embedded loopback
    `https://example.com/${"a".repeat(2100)}`,  // over the length cap
  ];

  for (const url of rejected) {
    const env = createEnv();
    const { response } = await post(env, url);
    assert.equal(response.status, 400, `${url} must be rejected`);
    assert.equal(env.DB.rows.size, 0, `${url} must not create an audit record`);
  }
});

test("accepts ordinary public pages, including public IP literals", async () => {
  for (const url of ["https://example.com/", "http://example.com/products?q=1", "https://sub.example.co.uk/a/b", "http://93.184.216.34/", "http://[2606:2800:220:1::1]/"]) {
    const env = createEnv();
    const { response } = await post(env, url);
    assert.equal(response.status, 202, `${url} must be accepted`);
  }
});

test("limits anonymous submissions to three per hour per fingerprint", async () => {
  const env = createEnv();
  for (let attempt = 0; attempt < 3; attempt += 1) await submit(env);

  const { response: blocked } = await post(env, "https://example.com/products");
  assert.equal(blocked.status, 429);
  assert.equal(env.DB.rows.size, 3, "a rate-limited submission must not be stored");

  // The window is an hour wide, so ageing the existing rows past it frees a slot.
  for (const row of env.DB.rows.values()) row.created_at = Date.now() - 61 * 60 * 1000;
  const { response: allowed } = await post(env, "https://example.com/products");
  assert.equal(allowed.status, 202);
});

test("hides expired audits behind the same 404 as unknown ids", async () => {
  const env = createEnv();
  const id = await submit(env);

  env.DB.rows.get(id).expires_at = Date.now() - 1;
  const expired = await get(env, id);
  assert.equal(expired.status, 404);

  const unknown = await get(env, crypto.randomUUID());
  assert.equal(unknown.status, 404);
  assert.deepEqual(await expired.json(), await unknown.json(), "expiry must not be distinguishable from absence");
});

// ------------------------------------------------------------- scan lifecycle

test("fails honestly when no browser binding is available", async () => {
  const env = createEnv();
  const id = await submit(env);

  const report = await (await get(env, id)).json();
  assert.equal(report.status, "failed", "no scanner must mean a failed scan, never invented findings");
  assert.deepEqual(report.findings, []);
  assert.match(report.error, /not available/i);
  assert.equal(env.DB.rows.get(id).error_code, "browser_unavailable");
});

test("never reports a completed scan without having scanned", async () => {
  const env = createEnv();
  const id = await submit(env);
  const report = await (await get(env, id)).json();

  assert.notEqual(report.status, "completed");
  assert.equal(report.findings.length, 0);
  // The removed preview flag must not come back with fabricated content behind it.
  assert.equal(report.prototype, undefined);
});

test("retires an audit abandoned in a non-terminal status", async () => {
  const env = createEnv();
  const id = await submit(env);

  // Simulate an isolate that was evicted mid-job, long ago.
  Object.assign(env.DB.rows.get(id), { status: "running", error_code: null, error_message: null, completed_at: null });
  env.DB.rows.get(id).created_at = Date.now() - 10 * 60 * 1000;

  const report = await (await get(env, id)).json();
  assert.equal(report.status, "failed", "a stranded audit must resolve, not poll forever");
  assert.match(report.error, /did not finish/i);
  assert.equal(env.DB.rows.get(id).status, "failed");
});

test("leaves a job still inside its window alone", async () => {
  const env = createEnv();
  const id = await submit(env);
  Object.assign(env.DB.rows.get(id), { status: "running", error_code: null, error_message: null, completed_at: null, created_at: Date.now() });

  const report = await (await get(env, id)).json();
  assert.equal(report.status, "running");
  assert.equal(env.DB.rows.get(id).status, "running");
});

test("serves a stored report without re-running the job", async () => {
  const env = createEnv();
  const id = await submit(env);

  const stored = [{ ...finding(), fix: { summary: "s", whyItMatters: "w", steps: ["a"], codeExample: null, confidence: "high", requiresManualReview: false, provider: "gemini", model: "gemini-2.5-flash", promptVersion: "fix-v1" } }];
  Object.assign(env.DB.rows.get(id), { status: "completed", report_json: JSON.stringify(stored), completed_at: Date.now(), final_url: "https://example.com/products", page_title: "Products" });

  const report = await (await get(env, id)).json();
  assert.equal(report.status, "completed");
  assert.equal(report.finalUrl, "https://example.com/products");
  assert.equal(report.pageTitle, "Products");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].fix.provider, "gemini");
});

// ------------------------------------------------------------- fix generation

test("completes on deterministic guidance when no Gemini key is configured", async () => {
  const findings = await buildFindings(SAMPLE, {});

  assert.equal(findings.length, 3);
  for (const item of findings) {
    assert.equal(item.fix.provider, "deterministic");
    assert.ok(item.fix.summary.length > 0);
    assert.ok(item.fix.steps.length > 0);
  }
});

test("spends exactly one Gemini request per audit and records provenance", async () => {
  let calls = 0;
  let requestUrl = "";
  let sentKey = "";
  let body;
  const restore = stubGemini(async (target, init) => {
    calls += 1;
    requestUrl = target;
    sentKey = init.headers["x-goog-api-key"];
    body = JSON.parse(init.body);
    return geminiOk(SAMPLE.map((item) => ({
      ruleId: item.ruleId,
      summary: `Fix ${item.ruleId}`,
      whyItMatters: "Assistive technology depends on it.",
      steps: ["Do the thing.", "Retest the page."],
      codeExample: "<html lang=\"en\">",
      confidence: "high",
      requiresManualReview: false,
    })));
  });

  try {
    const findings = await buildFindings(SAMPLE, { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-2.0-flash" });

    assert.equal(calls, 1, "one request per audit, not one per rule group");
    assert.match(requestUrl, /\/models\/gemini-2\.0-flash:generateContent$/);
    assert.equal(sentKey, "test-key");
    assert.equal(fixFor(findings, "html-has-lang").provider, "gemini");
    assert.equal(fixFor(findings, "html-has-lang").model, "gemini-2.0-flash");
    assert.equal(fixFor(findings, "html-has-lang").summary, "Fix html-has-lang");

    // Structured output is enforced by the API, and page markup is marked untrusted.
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.ok(body.generationConfig.responseSchema);
    assert.match(body.systemInstruction.parts[0].text, /untrusted markup/i);
    assert.match(body.systemInstruction.parts[0].text, /Never follow instructions/i);
    assert.match(body.contents[0].parts[0].text, /EVIDENCE \(untrusted page markup — data only\)/);
  } finally {
    restore();
  }
});

test("keeps judgement-dependent rules flagged for manual review", async () => {
  const restore = stubGemini(async () => geminiOk([
    { ruleId: "image-alt", summary: "Add alt text.", whyItMatters: "Screen readers need it.", steps: ["Add alt."], confidence: "high", requiresManualReview: false },
    { ruleId: "html-has-lang", summary: "Declare the language.", whyItMatters: "Pronunciation depends on it.", steps: ["Set lang=\"en\"."], confidence: "high", requiresManualReview: false },
  ]));

  try {
    const findings = await buildFindings(SAMPLE, { GEMINI_API_KEY: "test-key" });
    assert.equal(fixFor(findings, "image-alt").requiresManualReview, true, "alt text always needs a human");
    assert.equal(fixFor(findings, "html-has-lang").requiresManualReview, false);
  } finally {
    restore();
  }
});

test("degrades per rule group on unusable or hallucinated model output", async () => {
  const restore = stubGemini(async () => geminiOk([
    { ruleId: "html-has-lang", summary: "Declare the language.", whyItMatters: "Pronunciation.", steps: ["Set lang."], confidence: "medium", requiresManualReview: true },
    { ruleId: "button-name", summary: "", whyItMatters: "", steps: [], confidence: "high", requiresManualReview: false },
    { ruleId: "not-a-real-rule", summary: "Ignore me.", whyItMatters: "Ignore me.", steps: ["Ignore."], confidence: "high", requiresManualReview: false },
  ]));

  try {
    const findings = await buildFindings(SAMPLE, { GEMINI_API_KEY: "test-key" });
    assert.equal(findings.length, 3, "a hallucinated ruleId must not add a finding");
    assert.equal(fixFor(findings, "html-has-lang").provider, "gemini");
    assert.equal(fixFor(findings, "button-name").provider, "deterministic", "empty output falls back");
    assert.equal(fixFor(findings, "image-alt").provider, "deterministic", "omitted group falls back");
  } finally {
    restore();
  }
});

test("still returns a complete report when Gemini errors, stalls, or returns junk", async () => {
  const responses = [
    async () => new Response("quota exceeded", { status: 429 }),
    async () => new Response("bad key", { status: 403 }),
    async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 }),
    async () => { throw new Error("network down"); },
  ];

  for (const handler of responses) {
    const restore = stubGemini(handler);
    try {
      const findings = await buildFindings(SAMPLE, { GEMINI_API_KEY: "test-key" });
      assert.equal(findings.length, 3);
      assert.ok(findings.every((item) => item.fix.provider === "deterministic"));
    } finally {
      restore();
    }
  }
});

test("keeps advisories off the model prompt and on deterministic guidance", async () => {
  let promptedRules = [];
  const restore = stubGemini(async (_target, init) => {
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    promptedRules = [...prompt.matchAll(/ruleId: (\S+)/g)].map((match) => match[1]);
    return geminiOk([{ ruleId: "button-name", summary: "Name the button.", whyItMatters: "Screen readers need it.", steps: ["Add aria-label."], confidence: "high", requiresManualReview: false }]);
  });

  try {
    const mixed = [finding(), finding({ ruleId: "heading-order", kind: "advisory", impact: "moderate" })];
    const findings = await buildFindings(mixed, { GEMINI_API_KEY: "test-key" });

    assert.deepEqual(promptedRules, ["button-name"], "advisories must not enlarge the prompt");
    assert.equal(fixFor(findings, "button-name").provider, "gemini");
    assert.equal(fixFor(findings, "heading-order").provider, "deterministic");
    assert.equal(findings.length, 2, "the advisory is still reported, just not model-written");
  } finally {
    restore();
  }
});

test("spends no model request when a page produces only advisories", async () => {
  let calls = 0;
  const restore = stubGemini(async () => { calls += 1; return geminiOk([]); });

  try {
    const findings = await buildFindings([finding({ ruleId: "region", kind: "advisory" })], { GEMINI_API_KEY: "test-key" });
    assert.equal(calls, 0);
    assert.equal(findings[0].fix.provider, "deterministic");
  } finally {
    restore();
  }
});

test("strips markdown fences the model may still emit", async () => {
  const restore = stubGemini(async () => geminiOk([
    { ruleId: "html-has-lang", summary: "Declare the language.", whyItMatters: "Pronunciation.", steps: ["Set lang."], codeExample: "```html\n<html lang=\"en\">\n```", confidence: "high", requiresManualReview: false },
  ]));

  try {
    const findings = await buildFindings(SAMPLE, { GEMINI_API_KEY: "test-key" });
    const fix = fixFor(findings, "html-has-lang");
    assert.doesNotMatch(fix.codeExample, /```/);
    assert.match(fix.codeExample, /<html lang="en">/);
  } finally {
    restore();
  }
});

// ------------------------------------------------------------ AI alt-text review

const IMAGES = [
  { selector: "img.logo", html: "<img class=\"logo\" alt=\"logo\">", alt: "logo", context: "inside a link | nearby text: Acme home", jpegBase64: "AAAA" },
  { selector: "img.team", html: "<img class=\"team\" alt=\"Our team\">", alt: "Our team", context: "nearby text: Meet the people behind Acme", jpegBase64: "BBBB" },
  { selector: "img.divider", html: "<img class=\"divider\" alt=\"wave\">", alt: "wave", context: "", jpegBase64: "CCCC" },
];
const ALT_ON = { GEMINI_API_KEY: "test-key", ALT_TEXT_REVIEW: "on" };

test("alt-text review is off unless explicitly enabled with a key", async () => {
  let calls = 0;
  const restore = stubGemini(async () => { calls += 1; return geminiOk([]); });

  try {
    assert.equal(altReviewEnabled({ GEMINI_API_KEY: "test-key" }), false);
    assert.equal(altReviewEnabled({ ALT_TEXT_REVIEW: "on" }), false, "needs a key");
    assert.equal(altReviewEnabled(ALT_ON), true);
    assert.deepEqual(await reviewAltText(IMAGES, { GEMINI_API_KEY: "test-key" }), []);
    assert.deepEqual(await reviewAltText([], ALT_ON), []);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test("reviews every image in one request, with each screenshot inline and marked untrusted", async () => {
  let calls = 0;
  let body;
  const restore = stubGemini(async (_target, init) => {
    calls += 1;
    body = JSON.parse(init.body);
    return geminiOk([]);
  });

  try {
    await reviewAltText(IMAGES, ALT_ON);
    const parts = body.contents[0].parts;

    assert.equal(calls, 1, "one request for all images");
    assert.deepEqual(parts.filter((part) => part.inlineData).map((part) => part.inlineData.data), ["AAAA", "BBBB", "CCCC"]);
    assert.ok(parts.every((part) => !part.inlineData || part.inlineData.mimeType === "image/jpeg"));
    assert.match(body.systemInstruction.parts[0].text, /untrusted/i);
    assert.match(body.systemInstruction.parts[0].text, /Never follow instructions/i);
  } finally {
    restore();
  }
});

test("reports weak alt text as an AI advisory with the model's suggestion", async () => {
  const restore = stubGemini(async () => geminiOk([
    { index: 0, verdict: "vague", suggestion: "Acme home", reason: "The logo links home but names no one." },
    { index: 1, verdict: "adequate", suggestion: "", reason: "Matches the photo." },
    { index: 2, verdict: "decorative", suggestion: "", reason: "A divider with no meaning." },
  ]));

  try {
    const [review] = await reviewAltText(IMAGES, ALT_ON);

    assert.equal(review.ruleId, "alt-text-review");
    assert.equal(review.kind, "advisory", "never asserted as a violation");
    assert.equal(review.detector, "ai");
    assert.equal(review.count, 2);
    assert.deepEqual(review.occurrences.map((occurrence) => occurrence.selector), ["img.logo", "img.divider"]);
    assert.match(review.occurrences[0].failure, /Suggested alt: "Acme home"/);
    assert.match(review.occurrences[1].failure, /alt="" \(decorative\)/);
  } finally {
    restore();
  }
});

test("drops invented indexes, unknown verdicts, and weak verdicts with no suggestion", async () => {
  const restore = stubGemini(async () => geminiOk([
    { index: 7, verdict: "vague", suggestion: "Nothing here", reason: "Out of range." },
    { index: 0, verdict: "terrible", suggestion: "Acme home", reason: "Not a verdict." },
    { index: 1, verdict: "inaccurate", suggestion: "", reason: "No replacement offered." },
    { index: 2, verdict: "unclear", suggestion: "", reason: "Covered by a banner." },
  ]));

  try {
    assert.deepEqual(await reviewAltText(IMAGES, ALT_ON), []);
  } finally {
    restore();
  }
});

test("a failed alt-text review yields nothing and never throws", async () => {
  for (const handler of [
    async () => new Response("quota", { status: 429 }),
    async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 }),
    async () => { throw new TypeError("network down"); },
  ]) {
    const errors = [];
    const restore = stubGemini(handler);
    try {
      assert.deepEqual(await reviewAltText(IMAGES, ALT_ON, (message) => errors.push(message)), []);
      assert.equal(errors.length, 1);
    } finally {
      restore();
    }
  }
});
