import type * as React from "react";
import Link from "next/link";

export default function Home(): React.ReactElement {
  return (
    <div>
      <h1>FORMOS</h1>
      <p className="muted">Team workspaces with granular roles — the control plane for everything else.</p>
      <div className="row">
        <Link href="/login">Sign in</Link>
        <Link href="/app">Open workspace</Link>
      </div>
    </div>
  );
}
