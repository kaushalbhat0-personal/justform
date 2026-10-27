# File Pipeline — quarantine by default

## Status
DECIDED (accepted 2026-10-28; Spike 6 bounded confirmation before Phase 6).

## Flow
```text
Browser → single-use upload grant → presigned PUT to QUARANTINE prefix
 → AV scan (async) → metadata verify → promote to SAFE prefix
 → transactional attach (refs only) → signed download (grant-checked)
```

## Stage controls
- **Grant:** single-use, tied to a valid form session + captcha-passed, scoped to `(form_id, field_id, mime-allowlist, max-bytes, 15-min TTL)`. Anonymous public uploads allowed ONLY through this grant — no open file POST anywhere.
- **Quarantine prefix:** `w/{ws}/quarantine/{form}/{uuid}`. Unlistable, no serving. Every object AV-scanned before promotion; unscanned objects are unreachable by any read path.
- **AV options at ₹0:** (a) local ClamAV on the worker host (self-host-capable, ₹0, chosen path), (b) commercial scan API at Stage 1+ (pay per MB, no self-host ops), (c) deferred-scan-with-quarantine (never serve unscanned — this is the invariant, not an option). DECISION: quarantine-by-default + async ClamAV on the worker; commercial API evaluated at Stage 1 by cost/scan-lag data (Spike 6).
- **Metadata verify:** content-sniff (never trust client MIME), allowlist MIME+ext per field, size re-check vs plan cap, image dimension bounds, archive nesting-depth cap.
- **MIME spoofing / SVG XSS / polyglots / malware:** sniff + allowlist; SVG/HTML served ONLY as `Content-Disposition: attachment` + `nosniff`, never inline; polyglot/executable → fail-closed reject; EICAR must be caught in pre-MVP abuse tests.
- **Fail policy:** executables fail closed (reject + alert); scan-infra failure quarantines + alerts (fail closed for serve, open for intake with quarantine — submissions never lost, files pending).
- **Tenant isolation:** `w/{ws}/…` prefixes + RLS on the `attachments` metadata rows; signed URLs minted only after a grant check, short TTL, single-object scope.
- **Abandoned uploads:** grant TTL + quarantine sweeper (24h) → delete + meter reclaim. **Retention/deletion:** plan caps enforced at grant time; per-workspace retention policy (auto-delete like Tally Business is the reference); soft-delete → hard purge including backups window; DSR erases objects + metadata + delivery-log refs. **Quotas:** bytes metered at grant (reserve) and reconciled at promote/delete — metering hooks in both directions.

## Alternatives Considered
Direct-to-safe upload (rejected — scan race), inline base64 in answers JSONB (rejected — bloats rows, breaks caching, un-scannable), third-party upload widget with vendor storage (rejected — data-residency + lock-in + cost).

## Open Questions
ClamAV signature-update cadence + scan-lag SLO (Spike 6 measures); commercial-scan cost crossover point.
