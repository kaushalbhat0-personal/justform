"use client";
import type * as React from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseBrowser";

/** Email/password auth (magic-link/SSO arrive in later phases). */
export function LoginForm(): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(mode: "signin" | "signup"): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const supabase = supabaseBrowser();
      const result =
        mode === "signin"
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signUp({ email, password });
      if (result.error) {
        setError(result.error.message);
        return;
      }
      router.push("/app");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      {error ? <div className="error" role="alert">{error}</div> : null}
      <form onSubmit={(e) => { e.preventDefault(); void submit("signin"); }}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="row" style={{ marginTop: 16 }}>
          <button type="submit" disabled={busy}>{busy ? "Working…" : "Sign in"}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void submit("signup")}>
            Create account
          </button>
        </div>
      </form>
    </div>
  );
}
