import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Clarity scanner landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Clarity — AI-assisted accessibility scanner/);
  assert.match(html, /Catch accessibility/);
  assert.match(html, /id="page-url"/);
  assert.match(html, /Scan this page/);
  assert.match(html, /A scan, not a certification/);
  assert.match(html, /WCAG 2\.2 A &amp; AA/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("keeps the finished product free of disposable starter files", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<ScanForm \/>/);
  assert.match(layout, /Clarity — AI-assisted accessibility scanner/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|site-creator-vinext-starter/);
  await access(new URL("public/og.png", projectRoot));

  // Starter scaffold that shipped with the template and is no longer referenced.
  for (const removed of [
    "app/_sites-preview/SkeletonPreview.tsx",
    "app/chatgpt-auth.ts",
    "public/file.svg",
    "public/globe.svg",
    "public/window.svg",
  ]) {
    await assert.rejects(access(new URL(removed, projectRoot)), `${removed} should stay deleted`);
  }
});

test("declares its Cloudflare bindings in the config wrangler deploys", async () => {
  // The Vite plugin and `wrangler deploy` must read the same file, or local dev
  // and production drift. Comments are legal in .jsonc, so strip them first.
  const raw = await readFile(new URL("wrangler.jsonc", projectRoot), "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));

  assert.equal(config.main, "./worker/index.ts");
  assert.ok(config.compatibility_flags.includes("nodejs_compat"));
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].migrations_dir, "drizzle");
  // Without this the product cannot scan anything, which is its entire purpose.
  assert.equal(config.browser.binding, "BROWSER");

  // A key must never reach the committed config; secrets go through wrangler.
  assert.doesNotMatch(raw, /GEMINI_API_KEY\s*"?\s*:/);
  assert.equal(config.vars, undefined);

  // OpenAI Sites hosting has been removed; nothing may reference it again.
  await assert.rejects(access(new URL(".openai/hosting.json", projectRoot)));
  await assert.rejects(access(new URL("build/sites-vite-plugin.ts", projectRoot)));
  const viteConfig = await readFile(new URL("vite.config.ts", projectRoot), "utf8");
  assert.doesNotMatch(viteConfig, /\.openai|sites-vite-plugin/);
});
