-- FORMOS migration 0011 — nullable next_attempt_at for terminal rows (Phase 9 follow-up).
--
-- Both the tick fan-out (outbox, after 25 failed attempts) and the delivery
-- recorder (webhook_deliveries, permanent/dead outcomes) use NULL to mean
-- "no further attempt scheduled". Both columns were declared NOT NULL, so
-- terminal transitions fail on real Postgres. Drop the constraint on both;
-- claim queries already treat NULL as "never due" (IS NOT NULL guards), so
-- terminal rows are never re-claimed. No grant, policy, or RLS changes.

ALTER TABLE public.webhook_deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;
ALTER TABLE public.outbox ALTER COLUMN next_attempt_at DROP NOT NULL;
