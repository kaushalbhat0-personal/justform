import Link from "next/link";
import { notFound } from "next/navigation";
import { getMembership } from "@/lib/identity";
import { listMyTasks } from "@/lib/workflows";

/** Workspace team queue: pending approval tasks across forms. Mobile-first. */
export default async function TasksPage({
  params,
}: {
  params: Promise<{ ws: string }>;
}): Promise<React.ReactElement> {
  const { ws } = await params;
  const membership = await getMembership(ws);
  if (!membership) notFound();
  const tasks = await listMyTasks(ws).catch(() => []);
  const mine = tasks.filter(
    (t) => t["assignee_user_id"] === membership.id || t["claimed_by"] === membership.id,
  );
  const queue = tasks.filter(
    (t) => t["assignee_user_id"] !== membership.id && t["claimed_by"] !== membership.id,
  );

  return (
    <div>
      <p>
        <Link href={`/app/${ws}`}>← Workspace</Link>
      </p>
      <h1>My tasks</h1>
      <p className="muted">
        {mine.length} assigned to you · {queue.length} waiting in the team queue
      </p>
      {tasks.length === 0 ? (
        <div className="card" role="status">
          <p>No requests need your approval.</p>
        </div>
      ) : (
        <>
          {mine.length > 0 ? (
            <>
              <h2>Assigned to you</h2>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {mine.map((t) => (
                  <li key={t["id"] as string} className="card">
                    <div className="row">
                      <div>
                        <strong>Request</strong> <span className="badge">{t["status"] as string}</span>
                        <br />
                        <span className="muted">{t["created_at"] as string}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h2>Team queue</h2>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {queue.map((t) => (
              <li key={t["id"] as string} className="card">
                <div className="row">
                  <div>
                    <strong>Request</strong> <span className="badge">{t["status"] as string}</span>
                    <br />
                    <span className="muted">{t["created_at"] as string}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
