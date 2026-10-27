import type * as React from "react";
import Link from "next/link";
import { listMyMemberships } from "@/lib/identity";
import { signOutAction } from "@/lib/session";
import { ensureProfile } from "@/lib/workspaces";
import styles from "./shell.module.css";

export const dynamic = "force-dynamic"; // shell depends on session cookies; never prerendered

export default async function AppShell({ children }: { children: React.ReactNode }): Promise<React.ReactElement> {
  await ensureProfile();
  const memberships = await listMyMemberships();
  return (
    <div>
      <nav className={styles.nav} aria-label="Workspace">
        <Link href="/app" className={styles.brand}>FORMOS</Link>
        <ul className={styles.switcher} aria-label="Your workspaces">
          {memberships.map((m) => (
            <li key={m.workspaceId}>
              <Link href={`/app/${m.workspaceId}`}>{m.name} · {m.role}</Link>
            </li>
          ))}
        </ul>
        <form action={signOutAction} className={styles.logout}>
          <button type="submit" className="secondary">Sign out</button>
        </form>
      </nav>
      {children}
    </div>
  );
}
