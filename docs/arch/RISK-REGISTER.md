# Risk Register

Scale: P (probability) / I (impact) 1–5. D = detectability (H = early signal, L = silent until damage). Owner = module. Phase = earliest phase that must mitigate.

| ID | Risk | P×I | D | Mitigation | Owner | Phase |
|---|---|---|---|---|---|---|
| R-01 | Scope explosion (15 products at once) | 5×5 | H | MVP fence + flagged-off modules + build-order NOT-YET gates | arch | 0 |
| R-02 | RLS failure / cross-tenant leak | 2×5 | L | deny-default, RPC-only membership writes, matrix + isolation suite gate launch | authorization | 1 |
| R-03 | Schema lock-in (renderer-owned schema) | 3×5 | H | canonical owns; derivations generated; renderer wrapped + replaceable | forms-engine | 2 |
| R-04 | Builder perf collapse (100+ fields, rule churn) | 3×4 | H | islands, memoization, virtualization, S1/S2 budgets as CI gates | form-builder | 3 |
| R-05 | Embed perf miss (heavy loader, CLS) | 3×4 | H | ≤50KB critical, S5 Lighthouse gates, iframe-only MVP | renderer | 5 |
| R-06 | File abuse (malware/polyglot/SVG XSS) | 4×5 | L | quarantine-by-default, AV, sniffing, fail-closed executables, S6 + EICAR tests | files | 6 |
| R-07 | Queue failure / lost webhooks | 3×4 | H | transactional outbox, idempotent handlers, DLQ + replay, S7 chaos drill | workers | 8 |
| R-08 | Webhook duplication / receiver storms | 3×3 | H | idempotency keys, per-target backoff + breaker, S9 | webhooks | 8 |
| R-09 | Billing inaccuracy / over-admit at quota edge | 2×5 | L | counters+ledger + reconcile, S10 concurrency test, confirm-before-charge | metering | 9 |
| R-10 | Payment compliance (PAN scope, reconciliation gaps) | 2×5 | L | gateway-hosted only (SAQ-A), verify+reconcile jobs; DEFERRED to V1 + counsel | payments | V1 |
| R-11 | E-sign validity challenge | 1×5 | L | hash-chained trail + trusted timestamp; DEFERRED to V2 + ESIGN/IT-Act counsel | signatures | V2 |
| R-12 | AI PII leakage / prompt injection | 3×5 | L | redaction, draft-only edits, human approval, no training; DEFERRED to V2+ + DPA | ai | V2 |
| R-13 | Vendor lock-in (Supabase/Vercel proprietary paths) | 3×3 | H | portable SQL CI check, provider interfaces, exit triggers per stage | arch | 0 |
| R-14 | Supabase free-tier limits stall beta | 4×3 | H | Stage 0→1 exit triggers (lag, caps, storage, email) monitored from Phase 6 | arch | 6 |
| R-15 | Storage cost blowout (uploads at scale) | 3×4 | H | grant-time reservation, caps, retention auto-delete, per-ws cost view Stage 2 | files/billing | 9 |
| R-16 | Email deliverability (spam folder, throttling) | 3×3 | H | dedicated domain + SPF/DKIM pre-launch, queue + backoff, provider fallback plan | notifications | 8 |
| R-17 | Search scaling wall (FTS p95 >800ms) | 2×3 | H | explicit trigger → Typesense; rollup-first dashboards regardless | analytics | 10 |
| R-18 | Analytics scan blowout (dashboard over raw subs) | 3×4 | H | rollups-only reads enforced; raw tables never queried by dashboards | analytics | 10 |
| R-19 | Realtime complexity creep (CRDT envy) | 2×3 | H | locks+patches default; Yjs only on measured conflict data (REALTIME path) | builder/tables | 3/7 |
| R-20 | Support/billing trust incident (wrongful block/charge) | 2×4 | H | grace windows, confirm-before-charge, full ledger evidence, one-click export | billing | 9 |

Top-5 by expected loss: R-01, R-02, R-06, R-09, R-12. All five have mitigations starting in their listed phase with launch gates where applicable.
