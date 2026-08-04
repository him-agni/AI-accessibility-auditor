/** Cloudflare Worker entry point for the Clarity product preview. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { buildFindings } from "../lib/fixes";
import { representativeFindings } from "../lib/findings/representative";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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

/** Preview pacing. Replace both with real queue events once the scanner worker exists. */
const RUNNING_AFTER_MS = 700;
const GENERATE_AFTER_MS = 2100;
/**
 * How long a claimed generation may run before another poller reclaims it. The claim
 * is deliberately not re-driven — if the isolate that took it died, the audit would
 * otherwise sit in 'generating' forever and the client would poll against it forever.
 * Comfortably above the provider's own 15s timeout.
 */
const GENERATION_STALE_MS = 45_000;

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

    const createdAt = new Date(row.created_at).toISOString();
    const progress = (status: AuditStatus) => json({ id: row.id, url: row.submitted_url, status, createdAt, findings: [] });

    const elapsed = Date.now() - row.created_at;

    // Reclaim a generation whose isolate never came back, so the audit resolves
    // instead of stranding the client in an endless poll.
    if (row.status === "generating" && elapsed > GENERATE_AFTER_MS + GENERATION_STALE_MS) {
      const message = "The report did not finish generating. Try scanning this page again.";
      await env.DB.prepare("UPDATE audits SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND status = 'generating'")
        .bind("report_generation_stalled", message, Date.now(), row.id).run();
      return json({ id: row.id, url: row.submitted_url, status: "failed", createdAt, findings: [], error: message });
    }

    if (row.status === "queued" && elapsed > RUNNING_AFTER_MS) {
      await env.DB.prepare("UPDATE audits SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").bind(Date.now(), row.id).run();
      row.status = "running";
    }

    if ((row.status === "queued" || row.status === "running") && elapsed > GENERATE_AFTER_MS) {
      // Claim the transition so concurrent pollers cannot each spend a model request.
      const claim = await env.DB.prepare("UPDATE audits SET status = 'generating' WHERE id = ? AND status IN ('queued', 'running')").bind(row.id).run();
      if (claim.meta.changes === 0) return progress("generating");

      let host = "Scanned page";
      try { host = new URL(row.submitted_url).hostname; } catch { /* normalized on input */ }
      const pageTitle = `${host} — scanned page`;

      try {
        const findings = await buildFindings(representativeFindings(), env, (message) => console.warn(`[fixes] audit ${row.id}: ${message}`));
        const completedAt = Date.now();
        await env.DB.prepare("UPDATE audits SET status = 'completed', final_url = ?, page_title = ?, axe_version = ?, report_json = ?, completed_at = ? WHERE id = ?")
          .bind(row.submitted_url, pageTitle, "4.x", JSON.stringify(findings), completedAt, row.id).run();
        return json({ id: row.id, url: row.submitted_url, finalUrl: row.submitted_url, pageTitle, status: "completed", createdAt, completedAt: new Date(completedAt).toISOString(), findings, prototype: true });
      } catch (error) {
        // Never leave a claimed audit stuck in 'generating'.
        console.error(`[fixes] audit ${row.id} failed`, error);
        const message = "The report could not be generated. Try scanning this page again.";
        await env.DB.prepare("UPDATE audits SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ?")
          .bind("report_generation_failed", message, Date.now(), row.id).run();
        return json({ id: row.id, url: row.submitted_url, status: "failed", createdAt, findings: [], error: message });
      }
    }

    if (row.status === "completed") return json({ id: row.id, url: row.submitted_url, finalUrl: row.final_url, pageTitle: row.page_title, status: row.status, createdAt, completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined, findings: row.report_json ? JSON.parse(row.report_json) : [], prototype: true });
    if (row.status === "failed") return json({ id: row.id, url: row.submitted_url, status: row.status, createdAt, findings: [], error: row.error_message || "The scan failed." });
    return progress(row.status);
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
