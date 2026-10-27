import type * as React from "react";
import { requireUser } from "@/lib/identity";
import { AcceptPanel } from "./AcceptPanel";

export default async function InviteAcceptPage({ params }: { params: Promise<{ token: string }> }): Promise<React.ReactElement> {
  const { token } = await params;
  const user = await requireUser();
  return (
    <div>
      <h1>Join workspace</h1>
      <p className="muted">Signed in as {user.email ?? user.id}. Accepting binds the invitation to this account.</p>
      <AcceptPanel token={token} />
    </div>
  );
}
