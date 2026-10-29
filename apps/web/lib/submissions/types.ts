/**
 * Submission inbox shared types (Phase 7).
 * Client-safe: no server-only imports. Single source for row/page shapes so
 * server actions, pages, and client components cannot drift.
 */

export const SUBMISSION_STATUSES = ["new", "read", "archived"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export interface SubmissionRow {
  id: string;
  workspaceId: string;
  formId: string;
  publicationId: string;
  formVersionId: string;
  status: SubmissionStatus;
  submittedAt: string;
  statusChangedAt: string;
  payload: Record<string, unknown>;
}

export interface SubmissionSummary {
  primary: string;
  secondary: string | null;
}

export interface SubmissionListItem extends SubmissionRow {
  summary: SubmissionSummary;
  /** Published version number the row is pinned to (for badges). */
  publishedVersionNo: number | null;
}

export interface SubmissionPage {
  rows: SubmissionListItem[];
  /** Opaque keyset cursor for the next page; null when exhausted. */
  nextCursor: string | null;
  total: number;
}

export interface SubmissionFilters {
  status?: SubmissionStatus;
  /** Free text matched against text-like payload values (+ exact UUID match). */
  q?: string;
  /** ISO date bounds applied to submitted_at (from inclusive, to exclusive). */
  from?: string;
  to?: string;
}

export const INBOX_PAGE_SIZE_DEFAULT = 20;
export const INBOX_PAGE_SIZE_MAX = 100;

export function isSubmissionStatus(value: unknown): value is SubmissionStatus {
  return value === "new" || value === "read" || value === "archived";
}
