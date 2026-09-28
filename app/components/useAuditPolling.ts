"use client";

import { useEffect, useState } from "react";
import type { Finding } from "../../lib/fixes";

type Audit = {
  id: string;
  url: string;
  finalUrl: string;
  pageTitle: string;
  status: "queued" | "running" | "generating" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  findings: Finding[];
  error?: string;
};

/** The non-terminal states the progress card renders, plus the local failure state. */
export type Progress = "queued" | "running" | "generating" | "failed";

const POLL_INTERVAL_MS = 1200;
const MAX_CONSECUTIVE_ERRORS = 4;
/**
 * Wall-clock ceiling. The error counter only catches a failing fetch; an audit stuck
 * in a non-terminal status answers every poll successfully and would loop forever.
 * Above the worker's own 150s staleness sweep, so the server normally resolves first.
 */
const MAX_POLL_MS = 180_000;

/**
 * Poll an audit until it completes or fails. `status` mirrors the job's real
 * status rather than guessing from attempt count.
 */
export function useAuditPolling(auditId: string) {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [status, setStatus] = useState<Progress>("queued");
  const [failureMessage, setFailureMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    let consecutiveErrors = 0;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();

    function fail(message: string) {
      setFailureMessage(message);
      setStatus("failed");
    }

    function handleResult(response: Response, result: Audit) {
      if (!response.ok) return fail(result.error || "This report is no longer available.");
      if (result.status === "completed") return setAudit(result);
      if (result.status === "failed") return fail(result.error || "This page could not be scanned.");
      setStatus(result.status);
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    // Transient network trouble is worth retrying; a persistent outage is not
    // worth faking a result for. Never substitute example data for a real scan.
    function handleNetworkError() {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return fail("We lost contact with the scanner. Check your connection and try again.");
      timer = setTimeout(poll, POLL_INTERVAL_MS * consecutiveErrors);
    }

    async function poll() {
      if (Date.now() - startedAt > MAX_POLL_MS) return fail("This scan did not finish in time. Try scanning this page again.");
      try {
        const response = await fetch(`/api/audits/${auditId}`, { cache: "no-store" });
        const result = await response.json() as Audit;
        if (cancelled) return;
        consecutiveErrors = 0;
        handleResult(response, result);
      } catch {
        if (!cancelled) handleNetworkError();
      }
    }

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [auditId]);

  return { audit, status, failureMessage };
}
