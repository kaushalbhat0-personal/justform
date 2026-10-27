# Design System Architecture — FORMOS identity (original, not Jotform-derived)

Do not copy Jotform (or any competitor) visual identity: no logos, colors, illustrations, copy, or branded assets. What we study is pattern logic (palette/canvas/inspector, triage queues, filterable grids) — re-expressed in an original system.

## Foundations
- **Direction:** light-first, warm/light neutral foundation (never dark-first); professional, calm, information-dense where it earns it. Dark mode = future token swap, NOT MVP.
- **Accessibility:** WCAG 2.2 AA from day one — contrast ≥4.5:1 text, visible focus ring ALWAYS (3px outline offset, never `outline:none`), keyboard-complete builder (palette → canvas → inspector via roving tabindex + shortcuts), screen-reader announcements for logic/validation changes, reduced-motion respected.
- **Mobile-first:** touch targets ≥44px, responsive workspace → stacked inspector, tables degrade to cards <720px, renderer usable one-handed.

## Tokens (CSS variables, single source in `packages/ui/tokens`)
Colors: `--bg, --surface, --surface-raised, --border, --border-strong, --text, --text-muted, --primary (action), --primary-hover, --danger, --warning, --success, --info` + status hues for submission states (new/assigned/approved/spam) — all pairs contrast-checked. Spacing: 4pt scale. Type: system stack + one display + one body (bundled, subsetted); tabular numerals for tables; scale 12/14/16/20/24/32 with 1.5 body line-height. Radius: 6/10/16. Elevation: 3 levels + focus ring level. Motion: 120/200/300ms easings, transform+opacity only; skeleton shimmer only loading pattern.

## Component domains (architecture — no components built in this phase)
- **Form controls:** label-above-input default, inline errors with `aria-describedby`, describedby hints, error summary on submit, required-marker convention, disabled vs readonly semantics.
- **Builder controls:** left palette (searchable, keyboard-addable), center canvas (drop targets with visible affordance, field-level lock avatars), right inspector (grouped sections, rule builder with test-mode), command palette (`Cmd+K`: add field, go to, publish, run test), autosave indicator + undo depth.
- **Tables:** density toggle, sticky header + first column, cell states (editing/conflict/locked), empty-filtered vs empty-form distinction, bulk-action bar.
- **Overlays:** dialogs (one primary action, ESC + focus trap), toasts (success/info only — errors stay inline near cause), popovers for filters.
- **States:** empty (first-run guidance + template shortcut), loading (skeleton, never spinner-only on primary surfaces), error (retry + request_id), offline (queued-count banner on renderer).

## Governance
Tokens versioned; contrast + keyboard audits gate every release (see TESTING.md); no ad-hoc hex outside tokens (lint-enforced in IMPL phase).
