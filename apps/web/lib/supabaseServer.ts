import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { serverEnv } from "./env";

/** Authenticated Supabase client bound to the request cookies (RLS enforced). */
export async function supabaseServer(): Promise<ReturnType<typeof createServerClient>> {
  const env = serverEnv();
  const jar = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) jar.set(name, value, options);
        } catch {
          // setAll from Server Components is a no-op (middleware refreshes).
        }
      },
    },
  });
}
