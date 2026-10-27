/**
 * FORMOS design tokens v0 (Phase 0 foundation — values only, no components).
 * Light-first warm neutral. Single source of truth for color/spacing/type;
 * components (Phase 3+) must reference these tokens, never hardcode values.
 * WCAG 2.2 AA pairs verified at adoption; re-verify on any change.
 */
export const tokens = {
  color: {
    bg: "#FAF7F2",
    surface: "#FFFFFF",
    surfaceRaised: "#F3EEE6",
    border: "#E5DDD2",
    borderStrong: "#CFC3B4",
    text: "#1C1917",
    textMuted: "#78716C",
    primary: "#1D4ED8",
    primaryHover: "#1E40AF",
    danger: "#B91C1C",
    warning: "#B45309",
    success: "#15803D",
    info: "#0E7490",
    statusNew: "#1D4ED8",
    statusAssigned: "#B45309",
    statusApproved: "#15803D",
    statusSpam: "#78716C",
    focusRing: "#1D4ED8",
  },
  spacing: { "0": 0, "1": 4, "2": 8, "3": 12, "4": 16, "6": 24, "8": 32, "12": 48 },
  radius: { sm: 6, md: 10, lg: 16 },
  elevation: {
    "0": "none",
    "1": "0 1px 2px rgb(28 25 23 / 0.06)",
    "2": "0 4px 12px rgb(28 25 23 / 0.10)",
    "focus": "0 0 0 3px rgb(29 78 216 / 0.35)",
  },
  motion: { fast: 120, base: 200, slow: 300 },
  font: {
    body: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    display: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "ui-monospace, 'SF Mono', Menlo, monospace",
  },
  typeScale: [12, 14, 16, 20, 24, 32],
} as const;

export type Tokens = typeof tokens;
