import type * as React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getMembership } from "@/lib/identity";
import { supabaseServer } from "@/lib/supabaseServer";
import { listApiKeysAction } from "@/lib/apiKeys";
import { listWebhooksAction } from "@/lib/webhooks";
import { AuditList } from "./_components/AuditList";
import { InvitePanel } from "./_components/InvitePanel";
import { MemberTable } from "./_components/MemberTable";
import { ApiKeysPanel } from "./_components/ApiKeysPanel";
import { WebhooksPanel } from "./_components/WebhooksPanel";

export default async function WorkspacePage({ params }: { params: Promise<{ ws: string }> }): Promise<React.ReactElement> {
  const { ws } = await params;
  const membership = await getMembership(ws);
  if (!membership) notFound(); // uniform 404: URL workspace_id is a locator, never authority
  const supabase = await supabaseServer();
  const { data: workspace } = await supabase.from("workspaces").select("name, slug, plan").eq("id", ws).maybeSingle();
  const isPrivileged = membership.role === "owner" || membership.role === "admin";
  const [initialKeys, initialWebhooks, forms] = isPrivileged
    ? await Promise.all([
        listApiKeysAction(ws).catch(() => []),
        listWebhooksAction(ws).catch(() => []),
        supabase
          .from("forms")
          .select("id, title")
          .eq("workspace_id", ws)
          .order("title")
          .then((r: { data?: Array<{ id: string; title: string }> | null }) => ((r.data ?? []) as Array<{ id: string; title: string }>)),
      ])
    : [[], [], []];
  return (
    <div>
      <h1>{workspace?.name ?? "Workspace"}</h1>
      <p className="muted">Your role: <span className="badge">{membership.role}</span></p>
      <MemberTable workspaceId={ws} myRole={membership.role} myUserId={membership.id} />
      <p>
        <Link href={`/app/${ws}/forms`}>Forms</Link> · <Link href={`/app/${ws}/tasks`}>My tasks</Link>
      </p>
      {isPrivileged ? (
        <p>
          <Link href={`/app/${ws}/billing`}>Billing &amp; Usage</Link>
        </p>
      ) : null}
      <InvitePanel workspaceId={ws} myRole={membership.role} />
      {isPrivileged ? <ApiKeysPanel workspaceId={ws} myRole={membership.role} initialKeys={initialKeys} /> : null}
      {isPrivileged ? <WebhooksPanel workspaceId={ws} myRole={membership.role} forms={forms} initialWebhooks={initialWebhooks} /> : null}
      <AuditList workspaceId={ws} myRole={membership.role} />
    </div>
  );
}
