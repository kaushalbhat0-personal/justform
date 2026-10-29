"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SubmissionStatus } from "@/lib/submissions/types";

/** Inbox filter controls. State lives in the URL (shareable, server-rendered results). */
export function SubmissionFilters({
  current,
}: {
  current: { status?: SubmissionStatus; q?: string; from?: string; to?: string };
}): React.ReactElement {
  const router = useRouter();
  const [q, setQ] = useState(current.q ?? "");

  function push(next: Record<string, string | undefined>): void {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...current, ...next })) {
      if (value !== undefined && value !== "") params.set(key, value);
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <form
      className="card"
      role="search"
      aria-label="Filter submissions"
      onSubmit={(e) => {
        e.preventDefault();
        push({ q: q.trim() === "" ? undefined : q.trim() });
      }}
    >
      <div className="row">
        <label>
          Search{" "}
          <input
            type="search"
            name="q"
            value={q}
            maxLength={200}
            placeholder="Name, email, or submission ID"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          Status{" "}
          <select
            name="status"
            value={current.status ?? ""}
            onChange={(e) => push({ status: e.target.value === "" ? undefined : (e.target.value as SubmissionStatus) })}
          >
            <option value="">All</option>
            <option value="new">New</option>
            <option value="read">Read</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <label>
          From{" "}
          <input
            type="date"
            name="from"
            value={current.from ?? ""}
            onChange={(e) => push({ from: e.target.value === "" ? undefined : e.target.value })}
          />
        </label>
        <label>
          To{" "}
          <input
            type="date"
            name="to"
            value={current.to ?? ""}
            onChange={(e) => push({ to: e.target.value === "" ? undefined : e.target.value })}
          />
        </label>
        <button type="submit">Search</button>
      </div>
    </form>
  );
}
