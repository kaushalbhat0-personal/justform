# workers/ — BOUNDARY RESERVED (Phase 8)

Scheduled-tick handlers live here (one deployable, no separate worker host at Stage 0):

```text
outbox-tick (cron-secret authed internal route → bounded batch claim)
notification-dispatcher · webhook-sender · av-callback · rollups · gc
```

Rules (QUEUE-WORKERS.md, FIX-001): handlers run service-role with
`workspace_id`-pinned payloads; idempotent on `event_id`; retries with
backoff + DLQ; no persistent process; no caller workspace authority.
Nothing is implemented in Phase 0.
