import type * as React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getMembership } from "@/lib/identity";
import { supabaseServer } from "@/lib/supabaseServer";
import { AuditList } from "./_components/AuditList";
import { InvitePanel } from "./_components/InvitePanel";
import { MemberTable } from "./_components/MemberTable";

export default async function WorkspacePage({ params }: { params: Promise<{ ws: string }> }): Promise<React.ReactElement> {
  const { ws } = await params;
  const membership = await getMembership(ws);
  if (!membership) notFound(); // uniform 404: URL workspace_id is a locator, never authority
  const supabase = await supabaseServer();
  const { data: workspace } = await supabase.from("workspaces").select("name, slug, plan").eq("id", ws).maybeSingle();
  return (
    <div>
      <h1>{workspace?.name ?? "Workspace"}</h1>
      <p className="muted">Your role: <span className="badge">{membership.role}</span></p>
      <MemberTable workspaceId={ws} myRole={membership.role} myUserId={membership.id} />
      <p>
        <Link href={`/app/${ws}/forms`}>Forms</Link>
      </p>
      <InvitePanel workspaceId={ws} myRole={membership.role} />
      <AuditList workspaceId={ws} myRole={membership.role} />
    </div>
  );
}
