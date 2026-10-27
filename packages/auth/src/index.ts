/**
 * @formos/auth — ONE canonical application identity boundary (Phase 1).
 * Supabase Auth is implementation #1 behind this interface. Application code
 * (routes, actions, components) must use these types/helpers and never import
 * Supabase Auth APIs directly. The interface is deliberately thin: it must not
 * become a second authentication system.
 */

export interface SessionUser {
  id: string;
  email: string | null;
}

/** Minimal structural surface required from the Supabase client (injected). */
export interface AuthClientLike {
  auth: {
    getUser: () => Promise<{ data: { user: { id: string; email?: string | null } | null } }>;
    signOut: () => Promise<{ error: unknown }>;
  };
}

/** Normalize emails for comparison/binding (invitation email match). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeEmail(a) === normalizeEmail(b);
}

/** Extract the session user from an injected client. Null = unauthenticated. */
export async function getSessionUser(client: AuthClientLike): Promise<SessionUser | null> {
  const { data } = await client.auth.getUser();
  if (!data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

export async function signOutEverywhere(client: AuthClientLike): Promise<void> {
  const { error } = await client.auth.signOut();
  if (error) throw error;
}
