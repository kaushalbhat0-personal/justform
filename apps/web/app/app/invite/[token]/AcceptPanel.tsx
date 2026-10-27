"use client";
import type * as React from "react";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { acceptAction } from "@/lib/workspaces";

type State = { ok: true; workspaceId: string } | { ok: false; error: string } | null;

export function AcceptPanel({ token }: { token: string }): React.ReactElement {
  const router = useRouter();
  const [state, submit, pending] = useActionState<State, FormData>(
    async () => acceptAction(token),
    null,
  );
  useEffect(() => {
    if (state?.ok) {
      router.push(`/app/${state.workspaceId}`);
      router.refresh();
    }
  }, [state, router]);
  return (
    <div className="card">
      {state && !state.ok ? <div className="error" role="alert">{state.error}</div> : null}
      <form action={submit}>
        <div className="row">
          <button type="submit" disabled={pending}>{pending ? "Joining…" : "Accept invitation"}</button>
        </div>
      </form>
    </div>
  );
}
