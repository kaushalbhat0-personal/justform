/**
 * Cloudflare Turnstile verification boundary (Phase 6).
 * Server-side only BY CONVENTION: this module is imported exclusively by the
 * intake API route (never by client components), so the secret never enters
 * a browser bundle (G4-guarded). The `server-only` marker is deliberately
 * omitted to keep the boundary unit-testable; the route import is the seam.
 * Activation point: set TURNSTILE_SECRET_KEY and enable `captcha` in the
 * form's canonical settings. When the secret is unset, verification is
 * skipped with a one-line warning (documented fail-open for local/dev);
 * when configured, provider failures and negative verdicts REJECT
 * (fail-closed). `fetchImpl` is a test seam.
 */

export interface CaptchaVerdict {
  ok: boolean;
  skipped: boolean;
}

export async function verifyCaptcha(
  token: string | undefined,
  remoteIp: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptchaVerdict> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn("[captcha] TURNSTILE_SECRET_KEY unset — skipping bot verification (set it to enforce).");
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false, skipped: false };
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, skipped: false };
    const verdict = (await res.json()) as { success?: boolean };
    return { ok: verdict.success === true, skipped: false };
  } catch {
    // Provider unreachable while enforcement is configured: fail closed.
    return { ok: false, skipped: false };
  }
}
