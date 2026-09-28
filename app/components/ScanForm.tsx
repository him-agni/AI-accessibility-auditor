"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

/** A quick client-side check; the server re-validates everything. */
function parseWebUrl(value: string) {
  try {
    const parsed = new URL(value);
    const isWeb = ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
    return isWeb ? parsed : null;
  } catch {
    return null;
  }
}

/** Queue a scan and return its audit id. Throws with a message fit to show. */
async function startAudit(url: string) {
  const response = await fetch("/api/audits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await response.json() as { id?: string; message?: string };
  if (!response.ok || !data.id) throw new Error(data.message || "We could not start this scan.");
  return data.id;
}

export function ScanForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const parsed = parseWebUrl(url);
    if (!parsed) return setError("Enter a complete public URL, such as https://example.com");

    setSubmitting(true);
    try {
      const id = await startAudit(parsed.toString());
      router.push(`/audits/${id}?url=${encodeURIComponent(parsed.toString())}`);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "We could not start this scan. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <form className="scan-form" onSubmit={submit} noValidate>
      <label htmlFor="page-url">Public webpage URL</label>
      <div className={`url-shell ${error ? "has-error" : ""}`}>
        <span className="url-icon" aria-hidden="true">↗</span>
        <input
          id="page-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://your-site.com/page"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-describedby={error ? "url-error" : undefined}
          aria-invalid={Boolean(error)}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? <><span className="button-spinner" /> Starting…</> : <>Scan this page <span aria-hidden="true">→</span></>}
        </button>
      </div>
      {error && <p className="form-error" id="url-error" role="alert">{error}</p>}
      <p className="form-note"><span aria-hidden="true">◇</span> Public pages only. We never use your cookies or credentials.</p>
    </form>
  );
}
