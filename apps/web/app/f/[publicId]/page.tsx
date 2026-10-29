import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { FormosForm } from "@formos/renderer";
import { resolvePublicForm } from "@/lib/public/resolvePublicForm";
import { buildRendererArtifacts } from "@/lib/public/submissionGate";
import { PublicFormClient } from "./PublicFormClient";
import "./form.css";

/**
 * Public respondent route (Phase 6): /f/[publicId].
 * No authentication, no workspace context. Renders ONLY the immutable
 * published snapshot resolved server-side — never the draft, never
 * workspace metadata. Availability states render distinct safe UX.
 */

export const dynamic = "force-dynamic";

const CLOSED_COPY: Record<string, { title: string; body: string }> = {
  not_open: {
    title: "This form isn't open yet",
    body: "Responses open at the scheduled time. Please check back later.",
  },
  closed: {
    title: "This form is closed",
    body: "This form is no longer accepting responses.",
  },
  capped: {
    title: "This form has reached its response limit",
    body: "No further responses can be accepted.",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ publicId: string }> }): Promise<Metadata> {
  const { publicId } = await params;
  const resolved = await resolvePublicForm(publicId);
  if (!resolved.ok || !resolved.available) return { title: "Form" };
  return { title: resolved.title, description: resolved.description ?? undefined };
}

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}): Promise<React.ReactElement> {
  const { publicId } = await params;
  const resolved = await resolvePublicForm(publicId);
  if (!resolved.ok) notFound();
  if (!resolved.available) {
    const copy = CLOSED_COPY[resolved.reason] ?? CLOSED_COPY["closed"];
    return (
      <main className="shell public-form">
        <div className="card" role="status">
          <h1>{copy?.title}</h1>
          <p className="muted">{copy?.body}</p>
        </div>
      </main>
    );
  }

  const { jsonSchema, uiSchema } = buildRendererArtifacts(resolved.snapshot);

  return (
    <main className="shell public-form">
      <header>
        <p className="muted">
          <span className="badge">Published version {resolved.publishedVersionNo}</span>
        </p>
        <h1>{resolved.title}</h1>
        {resolved.description ? <p className="muted">{resolved.description}</p> : null}
      </header>
      <div className="card">
        <PublicFormClient
          publicId={resolved.publicId}
          snapshot={resolved.snapshot}
          jsonSchema={jsonSchema as unknown as ComponentProps<typeof FormosForm>["schema"]}
          uiSchema={uiSchema as unknown as ComponentProps<typeof FormosForm>["uiSchema"]}
          captchaRequired={resolved.snapshot.settings.captcha === true}
        />
      </div>
    </main>
  );
}
