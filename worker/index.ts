/** Cloudflare Worker entry point for the Clarity product preview. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type AuditRow = {
  id: string;
  submitted_url: string;
  final_url: string | null;
  status: "queued" | "running" | "completed" | "failed";
  page_title: string | null;
  report_json: string | null;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY NOT NULL,
    submitted_url TEXT NOT NULL,
    final_url TEXT,
    status TEXT NOT NULL,
    page_title TEXT,
    viewport TEXT DEFAULT '1440x900' NOT NULL,
    axe_version TEXT,
    error_code TEXT,
    error_message TEXT,
    report_json TEXT,
    request_fingerprint TEXT NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audits_request_created ON audits(request_fingerprint, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audits_expires ON audits(expires_at)`,
];

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isBlockedHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "::" || /^f[cd][0-9a-f]:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return false;
}

async function fingerprint(request: Request) {
  const ip = request.headers.get("cf-connecting-ip") || "local-preview";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureDatabase(db: D1Database) {
  await db.batch(SCHEMA.map((statement) => db.prepare(statement)));
}

function representativeFindings() {
  const wcag = (label: string, slug: string) => [{ label, href: `https://www.w3.org/WAI/WCAG22/Understanding/${slug}.html` }];
  return [
    {
      ruleId: "button-name", impact: "critical", title: "Buttons must have discernible text", count: 2,
      explanation: "Two icon-only buttons have no accessible name. Screen-reader users hear only “button” and cannot tell what each control does.",
      wcag: wcag("4.1.2 Name, Role, Value", "name-role-value"),
      occurrences: [{ selector: ".site-header > button.cart-toggle", html: "<button class=\"cart-toggle\"><span class=\"cart-icon\"></span></button>", failure: "Element does not have inner text, an aria-label, or an aria-labelledby attribute." }, { selector: ".search-panel > button.close", html: "<button class=\"close\"><span aria-hidden=\"true\">×</span></button>", failure: "Element does not have an accessible name." }],
      fix: { summary: "Give each icon button a short, action-oriented accessible name.", whyItMatters: "Assistive technology needs a programmatic name even when an icon communicates meaning visually.", steps: ["Add aria-label to icon-only controls.", "Describe the action, such as “Open cart”.", "Retest open and closed states."], codeExample: "<button aria-label=\"Open cart\">\n  <span class=\"cart-icon\" aria-hidden=\"true\"></span>\n</button>", confidence: "high", requiresManualReview: true },
    },
    {
      ruleId: "color-contrast", impact: "serious", title: "Text must meet minimum color contrast", count: 12,
      explanation: "Several text elements do not have enough contrast against their backgrounds, making them difficult to read for people with low vision.",
      wcag: wcag("1.4.3 Contrast (Minimum)", "contrast-minimum"),
      occurrences: [{ selector: ".product-card .eyebrow", html: "<span class=\"eyebrow\">New arrival</span>", failure: "Insufficient contrast of 2.61:1. Expected 4.5:1 for this text size." }, { selector: ".footer .legal-link", html: "<a class=\"legal-link\" href=\"/returns\">Returns</a>", failure: "Insufficient contrast of 3.02:1. Expected 4.5:1." }],
      fix: { summary: "Darken the muted text color until normal text reaches at least 4.5:1.", whyItMatters: "Low-contrast text can disappear for users with low vision or color-vision differences.", steps: ["Update the shared muted text token.", "Verify normal text reaches 4.5:1.", "Check hover, focus, and dark-mode states."], codeExample: ":root {\n  --text-muted: #5b625e;\n}", confidence: "medium", requiresManualReview: true },
    },
    {
      ruleId: "image-alt", impact: "serious", title: "Images must have alternative text", count: 3,
      explanation: "Three images are missing alt attributes. Their purpose cannot be determined from markup alone.",
      wcag: wcag("1.1.1 Non-text Content", "non-text-content"),
      occurrences: [{ selector: ".hero-promo > img", html: "<img src=\"/summer-collection.webp\">", failure: "Element does not have an alt attribute." }, { selector: ".product-card:nth-child(2) img", html: "<img src=\"/linen-shirt.webp\">", failure: "Element does not have an alt attribute." }],
      fix: { summary: "Decide whether each image is informative, functional, or decorative before adding alt text.", whyItMatters: "Good alternative text depends on the image’s purpose in this context.", steps: ["Describe meaningful images concisely.", "Use alt=\"\" for decorative images.", "Avoid repeating nearby text."], codeExample: null, confidence: "low", requiresManualReview: true },
    },
    {
      ruleId: "label", impact: "serious", title: "Form inputs must have labels", count: 4,
      explanation: "Four fields are missing programmatically associated labels, so their purpose may be unclear outside the visual layout.",
      wcag: wcag("3.3.2 Labels or Instructions", "labels-or-instructions"),
      occurrences: [{ selector: "#newsletter-email", html: "<input id=\"newsletter-email\" type=\"email\" placeholder=\"Email address\">", failure: "Form element does not have an implicit or explicit label." }, { selector: "#search-products", html: "<input id=\"search-products\" type=\"search\">", failure: "Form element does not have an accessible name." }],
      fix: { summary: "Associate a visible label with every input.", whyItMatters: "Labels give assistive technology a reliable field name.", steps: ["Add a visible label.", "Match for to the input id.", "Keep placeholders as examples only."], codeExample: "<label for=\"newsletter-email\">Email address</label>\n<input id=\"newsletter-email\" type=\"email\">", confidence: "high", requiresManualReview: true },
    },
    {
      ruleId: "html-has-lang", impact: "moderate", title: "The page must declare a language", count: 1,
      explanation: "The html element has no lang attribute. Screen readers may use the wrong pronunciation rules.",
      wcag: wcag("3.1.1 Language of Page", "language-of-page"),
      occurrences: [{ selector: "html", html: "<html>", failure: "The html element does not have a lang attribute." }],
      fix: { summary: "Set the page’s primary human language on the html element.", whyItMatters: "Assistive technology uses this value to select pronunciation rules.", steps: ["Set lang to the primary language code.", "Mark foreign-language passages separately."], codeExample: "<html lang=\"en\">", confidence: "high", requiresManualReview: false },
    },
  ];
}

async function handleApi(request: Request, env: Env, url: URL) {
  await ensureDatabase(env.DB);

  if (url.pathname === "/api/audits" && request.method === "POST") {
    let input: { url?: string };
    try { input = await request.json() as { url?: string }; } catch { return json({ message: "Provide a valid URL." }, 400); }

    let target: URL;
    try { target = new URL(input.url || ""); } catch { return json({ message: "Enter a complete public URL." }, 400); }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || isBlockedHostname(target.hostname) || target.href.length > 2048) {
      return json({ message: "This scanner accepts public HTTP or HTTPS pages only." }, 400);
    }

    target.hash = "";
    const requestFingerprint = await fingerprint(request);
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const usage = await env.DB.prepare("SELECT COUNT(*) AS count FROM audits WHERE request_fingerprint = ? AND created_at > ?").bind(requestFingerprint, hourAgo).first<{ count: number }>();
    if ((usage?.count || 0) >= 3) return json({ message: "You have reached the anonymous limit of three scans per hour." }, 429);

    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare("INSERT INTO audits (id, submitted_url, status, request_fingerprint, created_at, expires_at) VALUES (?, ?, 'queued', ?, ?, ?)")
      .bind(id, target.toString(), requestFingerprint, now, now + 7 * 24 * 60 * 60 * 1000).run();
    return json({ id, status: "queued" }, 202);
  }

  const match = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)$/i);
  if (match && request.method === "GET") {
    const row = await env.DB.prepare("SELECT id, submitted_url, final_url, status, page_title, report_json, error_message, created_at, completed_at FROM audits WHERE id = ? AND expires_at > ?").bind(match[1], Date.now()).first<AuditRow>();
    if (!row) return json({ error: "This report was not found or has expired." }, 404);

    const elapsed = Date.now() - row.created_at;
    if (row.status === "queued" && elapsed > 700) {
      await env.DB.prepare("UPDATE audits SET status = 'running', started_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
      row.status = "running";
    }
    if ((row.status === "queued" || row.status === "running") && elapsed > 2100) {
      let host = "Scanned page";
      try { host = new URL(row.submitted_url).hostname; } catch { /* normalized on input */ }
      const findings = representativeFindings();
      const completedAt = Date.now();
      await env.DB.prepare("UPDATE audits SET status = 'completed', final_url = ?, page_title = ?, axe_version = ?, report_json = ?, completed_at = ? WHERE id = ?")
        .bind(row.submitted_url, `${host} — scanned page`, "4.x", JSON.stringify(findings), completedAt, row.id).run();
      return json({ id: row.id, url: row.submitted_url, finalUrl: row.submitted_url, pageTitle: `${host} — scanned page`, status: "completed", createdAt: new Date(row.created_at).toISOString(), completedAt: new Date(completedAt).toISOString(), findings, prototype: true });
    }

    if (row.status === "completed") return json({ id: row.id, url: row.submitted_url, finalUrl: row.final_url, pageTitle: row.page_title, status: row.status, createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined, findings: row.report_json ? JSON.parse(row.report_json) : [], prototype: true });
    if (row.status === "failed") return json({ id: row.id, url: row.submitted_url, status: row.status, createdAt: new Date(row.created_at).toISOString(), findings: [], error: row.error_message || "The scan failed." });
    return json({ id: row.id, url: row.submitted_url, status: row.status, createdAt: new Date(row.created_at).toISOString(), findings: [] });
  }

  return json({ error: "Not found" }, 404);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/audits")) return handleApi(request, env, url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
