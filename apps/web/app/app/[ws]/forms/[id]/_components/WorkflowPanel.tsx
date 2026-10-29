import { activateWorkflowAction, archiveWorkflowAction, createWorkflowAction } from "@/lib/workflows";

/** Minimal workflow configuration surface for builders/admins. No visual builder. */
export async function WorkflowPanel({
  workspaceId,
  formId,
  definition,
  canManage,
  canArchive,
}: {
  workspaceId: string;
  formId: string;
  definition: { id: string; status: string; currentVersionId: string | null } | null;
  canManage: boolean;
  canArchive: boolean;
}): Promise<React.ReactElement> {
  return (
    <div className="card">
      <h2 style={{ fontSize: "1rem", margin: "0 0 8px" }}>Approval workflow</h2>
      {definition === null ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            No approval workflow yet. New submissions will just be collected.
          </p>
          {canManage ? (
            <form
              action={async () => {
                "use server";
                await createWorkflowAction({ workspaceId, formId });
              }}
            >
              <button type="submit">Enable manager approval</button>
            </form>
          ) : null}
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            <span className="badge">{definition.status}</span> Submission → Manager approval → Approved / Rejected
          </p>
          {definition.status === "draft" && canManage ? (
            <form
              action={async () => {
                "use server";
                await activateWorkflowAction({ workspaceId, formId, definitionId: definition.id });
              }}
            >
              <button type="submit">Activate workflow</button>
            </form>
          ) : null}
          {definition.status === "active" && canArchive ? (
            <form
              action={async () => {
                "use server";
                await archiveWorkflowAction({ workspaceId, formId, definitionId: definition.id });
              }}
            >
              <button type="submit" className="secondary">
                Archive workflow
              </button>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}
