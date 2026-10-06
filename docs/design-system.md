# Kivro Web Design System

This documents the implemented light-only system, not a new theme or a complete
accessibility certification. Source of truth: `apps/web/src/app/globals.css`,
`components/ui.tsx`, and `components/shell.tsx` under `apps/web/src/`.

## Foundations

- Font: DM Sans, with system sans-serif fallbacks. Body 14px/1.55; paragraphs 1.7.
  Page headings 30px, section headings 18px, compact headings 15px, supporting text 12px.
  Local responsive rules reduce compact headings/metadata, not viewport-scaled type.
  Letter spacing is 0. Weights primarily 400/500/600; 650 is reserved for branding.
- Monospace is for IDs, versions, code, manifests, hashes, domains and secrets.
  Financial counters use tabular numerals. Do not style ordinary copy as a terminal.
- Spacing is based on 4px increments, with 2px/6px optical adjustments. Common
  control gaps 8/12px, form gaps 16/20px, section spacing 24/32px. Existing component
  dimensions are authoritative; do not add a second spacing framework.
- Surfaces are white with quiet dividers. Repeated capabilities/jobs/devices are
  meaningful objects; page sections use alignment, spacing and rules, not nested cards.
- Radius: 4/5px controls, 6/7px objects, 8px dialogs. Round dots/circular indicators are
  the deliberate exception. Shadows are limited to dialogs, selected segmented
  controls and a restrained focus ring, never decorative glow.

## Color Tokens

| Token | Value | Purpose |
| --- | --- | --- |
| `--paper` | `#ffffff` | Main canvas and control surfaces |
| `--surface` | `#f6f8f5` | Technical/secondary surfaces |
| `--ink` | `#202422` | Primary text |
| `--muted` | `#606a61` | Secondary text, placeholders, neutral statuses |
| `--subtle` | `#667060` | Tertiary labels; still readable normal text |
| `--line` | `#e4e8e2` | Quiet non-informational dividers |
| `--accent` / `--accent-hover` | `#087a57` / `#056746` | Main action/link/focus |
| `--accent-soft` | `#eaf5ef` | Selected-action background |
| `--success` / `--success-soft` | `#0f7954` / `#f0faf3` | Available/completed/success |
| `--warning` / `--warning-soft` | `#926421` / `#fff7e8` | Busy/paused/degraded/caution |
| `--danger` / `--danger-soft` | `#b33434` / `#fff1ef` | Failed/critical/security block |

Normal text tokens meet 4.5:1 against the six supported light/semantic surfaces.
Filled primary/destructive actions use white text and also meet 4.5:1. The focused
contrast test reads the actual stylesheet through Next's installed PostCSS parser
and calculates sRGB relative luminance; it also checks legacy caption selectors.
Placeholders explicitly use full opacity so browser defaults cannot dilute the token.
Disabled controls intentionally retain the existing reduced-opacity treatment.
Decorative borders/images are not normal-text contrast targets. These checks do
not certify every possible overlap, third-party content or assistive technology.

## Controls and States

- `Button`: primary for the local commitment, secondary for ordinary commands,
  ghost for low-emphasis actions, danger for destructive commitments. Busy state
  disables repeat clicks, keeps the label and exposes `aria-busy`.
- `IconButton`: Lucide symbol plus accessible name and native title tooltip.
  All built-in navigation/status/action icons use Lucide, not emoji branding.
- Native inputs/selects/textareas use consistent borders, small radii and
  focus-visible outlines. Checkboxes mean explicit binary choices; radios choose
  price tiers. Advanced options use native `details` disclosure.
- `Field`: links the label and description/error to a stable control ID and sets
  `aria-invalid`. `ContractForm` does the same for schema-generated controls.
  File inputs keep their field-help ID and add only their own `-upload-error` ID
  when an upload fails; either contract validation or upload failure marks that
  control invalid. Errors remain an announced alert. Clearing/retrying a local
  failure removes its error-only reference; other controls are unaffected.
- `Status`: one label/icon/color mapping across catalog, jobs, seller and agent.
  Available/completed is green; busy/running/paused amber; failures/security blocks
  red; offline/other neutral. Requested pause is distinct from acknowledged pause.
- `Notice`/`ErrorNotice`: visible message and icon, with status/alert semantics.
  Retriable requests expose an action; failures never become fake empty success.
- `Loading`: static structural skeletons where useful and inline progress text.
  Long jobs use returned stages/events, not an invented percentage.
- `Empty`: specific title, brief reason and a useful next action where available.
  Compact settings empties are 120px minimum, not repeated full-page blank panels.

## Navigation and Layout

- The first screen is operational marketplace search. Agent assistance is a
  separate route inside the same shell, not a replacement for browsing.
- Desktop uses a persistent sidebar; mobile uses a compact branded header and
  labelled navigation drawer with focus containment, Escape and focus restoration.
  Inactive background/navigation is inert. A keyboard-visible skip link targets main.
- Main breakpoints: 1200px for density, 960px for stacked detail/tool layouts,
  720px for mobile navigation/actions and450px for single-column objects/forms.
  Operational lists reflow rather than shrink as desktop tables. Long hashes/URLs
  wrap; result tables scroll inside their own container.
- Native dialogs provide modal focus behavior; `Dialog` labels the title and routes
  Escape/backdrop through the controlled close callback. Pending destructive
  actions can veto closing. Confirmations state impact before the final action.

## Review Rules

Keep primary decisions, price, timing, inputs/outputs and permission implications
visible. Use progressive disclosure for provenance, technical health and detailed
cost accounting. Retain unknown/incomplete states rather than inventing metrics.
No gradient decoration, hero marketing, nested card sections or gratuitous animation.
Respect `prefers-reduced-motion` for smooth scrolling, spinners and transitions.

Focused evidence: `apps/web/tests/contrast.test.ts`,
`apps/web/tests/file-accessibility.test.ts` and
`apps/web/e2e/accessibility-ui.spec.ts`. Existing real root/flow suites cover
selected desktop/mobile behavior. On 2026-10-06, the seven focused unit cases and
four desktop/mobile browser cases passed. Rendered checks cover neutral/muted/error
contrast and per-file validation, failed finalization and successful retry;
their labelled fixture screenshots were inspected for wrapping and overflow.
Full tablet, keyboard, long-content and delayed
loading/error visual matrices remain separate acceptance work. Master547 describes
eventual practical visual-regression coverage; screenshot capture alone is not a
pixel-regression baseline or a new mandatory MVP gate.
