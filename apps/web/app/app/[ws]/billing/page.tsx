import Link from "next/link";
import { notFound } from "next/navigation";
import { getMembership } from "@/lib/identity";
import { getUsageSummaryAction } from "@/lib/billing";
import { usagePercent } from "@formos/domain";

/** Minimal Billing & Usage surface: plan, period, meters, limits, remaining. Read-only. */
export default async function BillingPage({ params }: { params: Promise<{ ws: string }> }): Promise<React.ReactElement> {
  const { ws } = await params;
  const membership = await getMembership(ws);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    notFound(); // billing read is admin-floor; uniform 404 otherwise
  }
  const summary = await getUsageSummaryAction(ws).catch(() => null);
  if (!summary) notFound();
  const meters = [
    { label: "Active forms", m: summary.metrics.active_forms },
    { label: "Submissions (this period)", m: summary.metrics.monthly_submissions },
    { label: "API requests (this period)", m: summary.metrics.monthly_api_requests },
    { label: "Webhook deliveries (this period)", m: summary.metrics.monthly_webhook_deliveries },
  ];
  return (
    <div>
      <p>
        <Link href={`/app/${ws}`}>← Workspace</Link>
      </p>
      <h1>Billing &amp; Usage</h1>
      <p className="muted">
        Plan: <span className="badge">{summary.plan}</span> · Status: {summary.billing_status}
      </p>
      <p className="muted">
        Current period: {summary.period_start} → {summary.period_end}
      </p>
      <table>
        <thead>
          <tr>
            <th>Meter</th>
            <th>Used</th>
            <th>Limit</th>
            <th>Remaining</th>
            <th>Usage</th>
          </tr>
        </thead>
        <tbody>
          {meters.map(({ label, m }) => {
            const pct = usagePercent(m.used, m.limit);
            return (
              <tr key={label}>
                <td>{label}</td>
                <td>{m.used ?? "—"}</td>
                <td>{m.limit ?? "Unlimited"}</td>
                <td>{m.remaining ?? "—"}</td>
                <td>{pct === null ? <span className="muted">—</span> : <span className="badge">{pct.toFixed(0)}%</span>}</td>
              </tr>
            );
          })}
          <tr key="storage">
            <td>Storage</td>
            <td colSpan={4}>
              <span className="muted">Not metered yet — file storage accounting arrives with the storage subsystem.</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="muted">Metering only: no payments are processed. Quota denials return a deterministic error.</p>
    </div>
  );
}
