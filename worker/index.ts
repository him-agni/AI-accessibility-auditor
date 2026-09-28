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
 * IPv4 ranges a scan must never reach: "this" network, private, loopback,
 * link-local, and everything from multicast up. Each entry is an inclusive range
 * for the first octet and, where the block is narrower than /8, the second.
 */
const BLOCKED_IPV4_RANGES: { first: [number, number]; second?: [number, number] }[] = [
  { first: [0, 0] },
  { first: [10, 10] },
  { first: [127, 127] },
  { first: [169, 169], second: [254, 254] },
  { first: [172, 172], second: [16, 31] },
  { first: [192, 192], second: [168, 168] },
  { first: [224, 255] },
];

/**
 * IPv6 forms that carry an IPv4 address in their low 32 bits. `new URL()` re-renders
 * `::ffff:127.0.0.1` as `::ffff:7f00:1`, so the dotted-quad check never sees them
 * unless we decode the trailing hex groups back to an address first.
 */
const EMBEDDED_IPV4 = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal"];

const inRange = (value: number, [min, max]: [number, number]) => value >= min && value <= max;
const isOctet = (part: number) => Number.isInteger(part) && inRange(part, [0, 255]);

function isBlockedIPv4(host: string) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || !parts.every(isOctet)) return false;
  const [a, b] = parts;
  return BLOCKED_IPV4_RANGES.some(({ first, second }) => inRange(a, first) && (!second || inRange(b, second)));
}

function isLocalName(host: string) {
  return host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Loopback, unspecified, fc00::/7 unique-local and fe80::/10 link-local. */
function isPrivateIPv6(host: string) {
  // Both prefixes are four hex digits wide — matching only three silently
  // exempted every ULA address.
  return host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
}

/** Decode an IPv4-mapped or NAT64 IPv6 address to dotted-quad, or return null. */
function embeddedIPv4(host: string) {
  const embedded = EMBEDDED_IPV4.exec(host);
  if (!embedded) return null;
  const high = parseInt(embedded[1], 16);
  const low = parseInt(embedded[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isBlockedHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLocalName(host) || isPrivateIPv6(host)) return true;
  return isBlockedIPv4(embeddedIPv4(host) ?? host);
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

const MAX_URL_LENGTH = 2048;
const SCANS_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;
const REPORT_TTL_MS = 7 * 24 * HOUR_MS;

/** Parse and vet a submitted URL. Returns the URL to scan, or the reason it was refused. */
async function parseTarget(request: Request): Promise<URL | string> {
  let input: { url?: string };
  try { input = await request.json() as { url?: string }; } catch { return "Provide a valid URL."; }

  let target: URL;
  try { target = new URL(input.url || ""); } catch { return "Enter a complete public URL."; }

  const isPublicHttp = ["http:", "https:"].includes(target.protocol)
    && !target.username
    && !target.password
    && !isBlockedHostname(target.hostname)
    && target.href.length <= MAX_URL_LENGTH;
  if (!isPublicHttp) return "This scanner accepts public HTTP or HTTPS pages only.";

  target.hash = "";
  return target;
}

/** POST /api/audits — queue a scan and answer before it runs. */
async function createAudit(request: Request, env: Env, ctx: ExecutionContext) {
  const target = await parseTarget(request);
  if (typeof target === "string") return json({ message: target }, 400);

  const requestFingerprint = await fingerprint(request);
  const usage = await env.DB.prepare("SELECT COUNT(*) AS count FROM audits WHERE request_fingerprint = ? AND created_at > ?").bind(requestFingerprint, Date.now() - HOUR_MS).first<{ count: number }>();
  if ((usage?.count || 0) >= SCANS_PER_HOUR) return json({ message: "You have reached the anonymous limit of three scans per hour." }, 429);

  const id = crypto.randomUUID();
  const now = Date.now();
  const targetUrl = target.toString();
  await env.DB.prepare("INSERT INTO audits (id, submitted_url, status, request_fingerprint, created_at, expires_at) VALUES (?, ?, 'queued', ?, ?, ?)")
    .bind(id, targetUrl, requestFingerprint, now, now + REPORT_TTL_MS).run();

  // Answer immediately and scan in the background; the client polls for the result.
  ctx.waitUntil(runAudit(env, id, targetUrl));
  return json({ id, status: "queued" }, 202);
}

/** Mark an abandoned audit failed, unless it reached a terminal status meanwhile. */
async function retireStaleAudit(env: Env, id: string, message: string) {
  await env.DB.prepare("UPDATE audits SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed')")
    .bind("scan_stalled", message, Date.now(), id).run();
}

/** GET /api/audits/:id — the report, the failure, or the job's current status. */
async function readAudit(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT id, submitted_url, final_url, status, page_title, report_json, error_message, created_at, completed_at FROM audits WHERE id = ? AND expires_at > ?").bind(id, Date.now()).first<AuditRow>();
  if (!row) return json({ error: "This report was not found or has expired." }, 404);

  const base = { id: row.id, url: row.submitted_url, createdAt: new Date(row.created_at).toISOString() };

  if (row.status === "completed") {
    return json({
      ...base,
      finalUrl: row.final_url || row.submitted_url,
      pageTitle: row.page_title,
      status: row.status,
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
      findings: row.report_json ? JSON.parse(row.report_json) : [],
    });
  }

  if (row.status === "failed") return json({ ...base, status: row.status, findings: [], error: row.error_message || "The scan failed." });

  // Still working. The job runs in `waitUntil`; if that isolate was evicted nothing
  // will ever finish it, so a reader retires the audit rather than polling forever.
  if (Date.now() - row.created_at > JOB_STALE_MS) {
    const message = "This scan did not finish. Try scanning the page again.";
    await retireStaleAudit(env, row.id, message);
    return json({ ...base, status: "failed", findings: [], error: message });
  }

  return json({ ...base, status: row.status, findings: [] });
}

async function handleApi(request: Request, env: Env, url: URL, ctx: ExecutionContext) {
  await ensureDatabase(env.DB);

  if (url.pathname === "/api/audits" && request.method === "POST") return createAudit(request, env, ctx);

  const match = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)$/i);
  if (match && request.method === "GET") return readAudit(env, match[1]);

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
