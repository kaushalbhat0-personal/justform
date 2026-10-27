import type * as React from "react";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabaseServer";
import { getSessionUser } from "@formos/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage(): Promise<React.ReactElement> {
  const supabase = await supabaseServer();
  const user = await getSessionUser(supabase);
  if (user) redirect("/app");
  return (
    <div>
      <h1>Sign in</h1>
      <p className="muted">Use your workspace account. New here? Create an account below.</p>
      <LoginForm />
    </div>
  );
}
