import Link from "next/link";
import { notFound } from "next/navigation";
import { getMembership } from "@/lib/identity";
import { listForms } from "@/lib/forms";

/** Minimal forms list + create surface (Phase 4 lifecycle proof — not a builder). */
export default async function FormsPage({ params }: { params: Promise<{ ws: string }> }): Promise<React.ReactElement> {
  const { ws } = await params;
  const membership = await getMembership(ws);
  if (!membership) notFound();
  const forms = await listForms(ws);
  return (
    <div>
      <p>
        <Link href={`/app/${ws}`}>← Workspace</Link>
      </p>
      <h1>Forms</h1>
      <p className="muted">Your role: <span className="badge">{membership.role}</span></p>
      {forms.length === 0 ? (
        <p className="muted">No forms yet. Create the first draft below.</p>
      ) : (
        <ul>
          {forms.map((f) => (
            <li key={f.id}>
              <Link href={`/app/${ws}/forms/${f.id}`}>{f.title}</Link>{" "}
              <span className="muted">
                ({f.key} · rev {f.draft_revision} · {f.status})
              </span>
            </li>
          ))}
        </ul>
      )}
      <h2>Create form</h2>
      <form
        action={async (formData: FormData) => {
          "use server";
          const { createFormAction: create } = await import("@/lib/forms");
          await create({
            workspaceId: ws,
            title: String(formData.get("title") ?? ""),
            ...(String(formData.get("key") ?? "").trim() !== "" ? { key: String(formData.get("key")) } : {}),
            ...(String(formData.get("description") ?? "").trim() !== ""
              ? { description: String(formData.get("description")) }
              : {}),
            documentJson: String(formData.get("document") ?? ""),
          });
        }}
      >
        <label>
          Title <input name="title" required maxLength={200} />
        </label>
        <label>
          Key (optional slug) <input name="key" placeholder="contact_intake" />
        </label>
        <label>
          Description <input name="description" maxLength={500} />
        </label>
        <label>
          Canonical document (JSON)
          <textarea name="document" required rows={12} placeholder='{"schemaVersion":1,…}' />
        </label>
        <button type="submit">Create draft</button>
      </form>
    </div>
  );
}
