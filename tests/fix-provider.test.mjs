import assert from "node:assert/strict";
import test from "node:test";

// Exercises the built Worker bundle — the same artifact that ships — with an
// in-memory D1 stub and a stubbed Gemini endpoint. No network, no API key.
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-fix-provider`);
const { default: worker } = await import(workerUrl.href);

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
        const [id] = values;
        const row = rows.get(id);
        if (!row || !["queued", "running"].includes(row.status)) return meta(0);
        row.status = "generating";
        return meta(1);
      }
      if (/SET status = 'completed'/.test(sql)) {
        const [final_url, page_title, axe_version, report_json, completed_at, id] = values;
        Object.assign(rows.get(id), { status: "completed", final_url, page_title, axe_version, report_json, completed_at });
        return meta(1);
      }
      if (/SET status = 'failed'/.test(sql)) {
        const [error_code, error_message, completed_at, id] = values;
        Object.assign(rows.get(id), { status: "failed", error_code, error_message, completed_at });
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

const call = (env, path, init) => worker.fetch(new Request(`http://localhost${path}`, init), env, { waitUntil() {}, passThroughOnException() {} });

async function submit(env, url = "https://shop.example.com/products") {
  const response = await call(env, "/api/audits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  return id;
}

/** Fast-forward past the preview's queued/running pacing so the next poll generates. */
function readyToGenerate(env, id) {
  env.DB.rows.get(id).created_at = Date.now() - 60_000;
}

function stubGemini(handler) {
  globalThis.fetch = async (input, init) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes("generativelanguage.googleapis.com")) return handler(target, init);
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

const geminiOk = (body) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });

const fixFor = (findings, ruleId) => findings.find((finding) => finding.ruleId === ruleId).fix;

test("completes on deterministic guidance when no Gemini key is configured", async () => {
  const env = createEnv();
  const id = await submit(env);
  readyToGenerate(env, id);

  const report = await (await call(env, `/api/audits/${id}`)).json();
  assert.equal(report.status, "completed");
  assert.equal(report.prototype, true);
  assert.equal(report.findings.length, 5);
  for (const finding of report.findings) {
    assert.equal(finding.fix.provider, "deterministic");
    assert.ok(finding.fix.summary.length > 0);
    assert.ok(finding.fix.steps.length > 0);
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
    return geminiOk(["button-name", "color-contrast", "image-alt", "label", "html-has-lang"].map((ruleId) => ({
      ruleId,
      summary: `Fix ${ruleId}`,
      whyItMatters: "Assistive technology depends on it.",
      steps: ["Do the thing.", "Retest the page."],
      codeExample: "<html lang=\"en\">",
      confidence: "high",
      requiresManualReview: false,
    })));
  });

  try {
    const env = createEnv({ GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-2.0-flash" });
    const id = await submit(env);
    readyToGenerate(env, id);
    const report = await (await call(env, `/api/audits/${id}`)).json();

    assert.equal(calls, 1, "one request per audit, not one per rule group");
    assert.match(requestUrl, /\/models\/gemini-2\.0-flash:generateContent$/);
    assert.equal(sentKey, "test-key");
    assert.equal(report.findings.length, 5);
    assert.equal(fixFor(report.findings, "label").provider, "gemini");
    assert.equal(fixFor(report.findings, "label").model, "gemini-2.0-flash");
    assert.equal(fixFor(report.findings, "label").summary, "Fix label");

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
    const env = createEnv({ GEMINI_API_KEY: "test-key" });
    const id = await submit(env);
    readyToGenerate(env, id);
    const report = await (await call(env, `/api/audits/${id}`)).json();

    assert.equal(fixFor(report.findings, "image-alt").requiresManualReview, true, "alt text always needs a human");
    assert.equal(fixFor(report.findings, "html-has-lang").requiresManualReview, false);
  } finally {
    restore();
  }
});

test("degrades per rule group on unusable or hallucinated model output", async () => {
  const restore = stubGemini(async () => geminiOk([
    { ruleId: "label", summary: "Label every input.", whyItMatters: "Fields need names.", steps: ["Add a label."], confidence: "medium", requiresManualReview: true },
    { ruleId: "button-name", summary: "", whyItMatters: "", steps: [], confidence: "high", requiresManualReview: false },
    { ruleId: "not-a-real-rule", summary: "Ignore me.", whyItMatters: "Ignore me.", steps: ["Ignore."], confidence: "high", requiresManualReview: false },
  ]));

  try {
    const env = createEnv({ GEMINI_API_KEY: "test-key" });
    const id = await submit(env);
    readyToGenerate(env, id);
    const report = await (await call(env, `/api/audits/${id}`)).json();

    assert.equal(report.findings.length, 5, "a hallucinated ruleId must not add a finding");
    assert.equal(fixFor(report.findings, "label").provider, "gemini");
    assert.equal(fixFor(report.findings, "button-name").provider, "deterministic", "empty output falls back");
    assert.equal(fixFor(report.findings, "color-contrast").provider, "deterministic", "omitted group falls back");
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
      const env = createEnv({ GEMINI_API_KEY: "test-key" });
      const id = await submit(env);
      readyToGenerate(env, id);
      const report = await (await call(env, `/api/audits/${id}`)).json();

      assert.equal(report.status, "completed");
      assert.equal(report.findings.length, 5);
      assert.ok(report.findings.every((finding) => finding.fix.provider === "deterministic"));
    } finally {
      restore();
    }
  }
});

test("strips markdown fences the model may still emit", async () => {
  const restore = stubGemini(async () => geminiOk([
    { ruleId: "html-has-lang", summary: "Declare the language.", whyItMatters: "Pronunciation.", steps: ["Set lang."], codeExample: "```html\n<html lang=\"en\">\n```", confidence: "high", requiresManualReview: false },
  ]));

  try {
    const env = createEnv({ GEMINI_API_KEY: "test-key" });
    const id = await submit(env);
    readyToGenerate(env, id);
    const report = await (await call(env, `/api/audits/${id}`)).json();

    const fix = fixFor(report.findings, "html-has-lang");
    assert.doesNotMatch(fix.codeExample, /```/);
    assert.match(fix.codeExample, /<html lang="en">/);
  } finally {
    restore();
  }
});

test("only one concurrent poller triggers generation", async () => {
  let calls = 0;
  const restore = stubGemini(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return geminiOk([]);
  });

  try {
    const env = createEnv({ GEMINI_API_KEY: "test-key" });
    const id = await submit(env);
    readyToGenerate(env, id);

    const reports = await Promise.all(Array.from({ length: 5 }, () => call(env, `/api/audits/${id}`).then((response) => response.json())));
    assert.equal(calls, 1, "concurrent polls must not each spend free-tier quota");
    assert.equal(reports.filter((report) => report.status === "completed").length, 1);
    assert.ok(reports.filter((report) => report.status === "generating").length >= 1);
  } finally {
    restore();
  }
});

test("serves the stored report on later polls without calling the model again", async () => {
  let calls = 0;
  const restore = stubGemini(async () => {
    calls += 1;
    return geminiOk([{ ruleId: "label", summary: "Label every input.", whyItMatters: "Fields need names.", steps: ["Add a label."], confidence: "medium", requiresManualReview: true }]);
  });

  try {
    const env = createEnv({ GEMINI_API_KEY: "test-key" });
    const id = await submit(env);
    readyToGenerate(env, id);

    const first = await (await call(env, `/api/audits/${id}`)).json();
    const second = await (await call(env, `/api/audits/${id}`)).json();

    assert.equal(calls, 1);
    assert.equal(second.status, "completed");
    assert.deepEqual(second.findings.map((finding) => finding.fix.provider), first.findings.map((finding) => finding.fix.provider));
  } finally {
    restore();
  }
});
