"use server";
import "server-only";
import { redirect } from "next/navigation";
import { supabaseServer } from "./supabaseServer";

/** Server-side logout: signs out and drops usable session state. */
export async function signOutAction(): Promise<never> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}
