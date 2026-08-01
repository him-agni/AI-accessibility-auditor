"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function ScanForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    let parsed: URL;
    try {
      parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      if (parsed.username || parsed.password) throw new Error();
    } catch {
      setError("Enter a complete public URL, such as https://example.com");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/audits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: parsed.toString() }),
      });
      const data = await response.json() as { id?: string; message?: string };
      if (!response.ok || !data.id) throw new Error(data.message || "We could not start this scan.");
      router.push(`/audits/${data.id}?url=${encodeURIComponent(parsed.toString())}`);
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
