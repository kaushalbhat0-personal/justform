"use client";
import { createBrowserClient } from "@supabase/ssr";

/** Browser Supabase client — anon key only. No secrets may flow through here. */
export function supabaseBrowser(): ReturnType<typeof createBrowserClient> {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  );
}
