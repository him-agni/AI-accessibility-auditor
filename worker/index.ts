/** Cloudflare Worker entry point for Clarity. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { buildFindings } from "../lib/fixes";
import { scanPage, ScanError, type BrowserBinding } from "../lib/scan";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** Browser Rendering binding. Absent means scanning is unavailable, not that results are faked. */
  BROWSER?: BrowserBinding;
  /** Google AI Studio key. Absent is valid: reports fall back to deterministic guidance. */
  GEMINI_API_KEY?: string;
  /** Optional free-tier model override, e.g. "gemini-2.0-flash". */
  GEMINI_MODEL?: string;
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

type AuditStatus = "queued" | "running" | "generating" | "completed" | "failed";

type AuditRow = {
  id: string;
  submitted_url: string;
  final_url: string | null;
  status: AuditStatus;
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

/**
 * How long an audit may sit in a non-terminal status before a reader declares it
 * dead. The job runs in `waitUntil`, so nothing re-drives it if that isolate is
 * evicted; without this an abandoned audit would poll forever. Comfortably above
 * the scanner's own 55s ceiling plus the fix provider's 15s.
 */
const JOB_STALE_MS = 150_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * IPv6 forms that carry an IPv4 address in their low 32 bits. `new URL()` re-renders
 * `::ffff:127.0.0.1` as `::ffff:7f00:1`, so the dotted-quad branch never sees them
 * unless we decode the trailing hex groups back to an address first.
 */
const EMBEDDED_IPV4 = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

function isBlockedIPv4(host: string) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isBlockedHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // fc00::/7 unique-local and fe80::/10 link-local. Both prefixes are four hex digits
  // wide — matching only three silently exempted every ULA address.
  if (host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;

  const embedded = EMBEDDED_IPV4.exec(host);
  if (embedded) {
    const high = parseInt(embedded[1], 16);
    const low = parseInt(embedded[2], 16);
    return isBlockedIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }

  return isBlockedIPv4(host);
}

async function fingerprint(request: Request) {
  const ip = request.headers.get("cf-connecting-ip") || "local-preview";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bootstrap DDL runs at most once per isolate, not once per request. */
let schemaReady: Promise<unknown> | null = null;

function ensureDatabase(db: D1Database) {
  schemaReady ??= db.batch(SCHEMA.map((statement) => db.prepare(statement))).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

/**
 * The audit job: render, scan, then write remediations. Runs in `waitUntil` after the
 * submission has already been answered, so the client polls a real job rather than a
 * timer. Never throws — every exit writes a terminal status, or the audit would strand.
 */
async function runAudit(env: Env, auditId: string, targetUrl: string) {
  const log = (message: string) => console.warn(`[audit ${auditId}] ${message}`);

  const fail = async (code: string, message: string) => {
    await env.DB.prepare("UPDATE audits SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ?")
      .bind(code, message, Date.now(), auditId).run()
      .catch(() => log("could not record failure"));
  };

  try {
    await env.DB.prepare("UPDATE audits SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .bind(Date.now(), auditId).run();

    const scan = await scanPage(targetUrl, env, isBlockedHostname, (warning) => log(warning));

    // Findings are real from here; only the remediation text is model-generated.
    await env.DB.prepare("UPDATE audits SET status = 'generating', final_url = ?, page_title = ?, axe_version = ? WHERE id = ?")
      .bind(scan.finalUrl, scan.pageTitle, scan.axeVersion, auditId).run();

    const findings = await buildFindings(scan.findings, env, (message) => log(`fixes: ${message}`));

    await env.DB.prepare("UPDATE audits SET status = 'completed', report_json = ?, completed_at = ? WHERE id = ?")
      .bind(JSON.stringify(findings), Date.now(), auditId).run();
  } catch (error) {
    if (error instanceof ScanError) {
      log(`${error.code}: ${error.message}`);
      await fail(error.code, error.message);
      return;
    }
    // Unexpected: log for the operator, but never leak internals to the reporter.
    console.error(`[audit ${auditId}] unexpected failure`, error);
    await fail("scan_failed", "This page could not be scanned. Try again in a moment.");
  }
}

async function handleApi(request: Request, env: Env, url: URL, ctx: ExecutionContext) {
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
    const targetUrl = target.toString();
    await env.DB.prepare("INSERT INTO audits (id, submitted_url, status, request_fingerprint, created_at, expires_at) VALUES (?, ?, 'queued', ?, ?, ?)")
      .bind(id, targetUrl, requestFingerprint, now, now + 7 * 24 * 60 * 60 * 1000).run();

    // Answer immediately and scan in the background; the client polls for the result.
    ctx.waitUntil(runAudit(env, id, targetUrl));
    return json({ id, status: "queued" }, 202);
  }

  const match = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)$/i);
  if (match && request.method === "GET") {
    const row = await env.DB.prepare("SELECT id, submitted_url, final_url, status, page_title, report_json, error_message, created_at, completed_at FROM audits WHERE id = ? AND expires_at > ?").bind(match[1], Date.now()).first<AuditRow>();
    if (!row) return json({ error: "This report was not found or has expired." }, 404);

    const createdAt = new Date(row.created_at).toISOString();
    const progress = (status: AuditStatus) => json({ id: row.id, url: row.submitted_url, status, createdAt, findings: [] });

    if (row.status === "completed") {
      return json({
        id: row.id,
        url: row.submitted_url,
        finalUrl: row.final_url || row.submitted_url,
        pageTitle: row.page_title,
        status: row.status,
        createdAt,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
        findings: row.report_json ? JSON.parse(row.report_json) : [],
      });
    }

    if (row.status === "failed") return json({ id: row.id, url: row.submitted_url, status: row.status, createdAt, findings: [], error: row.error_message || "The scan failed." });

    // Still working. The job runs in `waitUntil`; if that isolate was evicted nothing
    // will ever finish it, so a reader retires the audit rather than polling forever.
    if (Date.now() - row.created_at > JOB_STALE_MS) {
      const message = "This scan did not finish. Try scanning the page again.";
      await env.DB.prepare("UPDATE audits SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed')")
        .bind("scan_stalled", message, Date.now(), row.id).run();
      return json({ id: row.id, url: row.submitted_url, status: "failed", createdAt, findings: [], error: message });
    }

    return progress(row.status);
  }

  return json({ error: "Not found" }, 404);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/audits")) return handleApi(request, env, url, ctx);

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
