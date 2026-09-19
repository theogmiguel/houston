# Houston UI Style Guide

This is the **UI/visual** doc for Houston — color roles, typography, layout
anatomy, component selection, and the rules that keep them coherent. Token *values*
live in code (`ui/src/renderer/src/theme.css`); this file documents the *roles and
rules* for using them.

## Overview & identity

Houston is a Linux-first desktop shell that hosts other people's tools — agent
CLIs in PTY terminals, a browser pane, an editor, a diff viewer. Its own chrome
should recede and frame; the panes are the product. The identity in one line:
**quiet monochrome chrome, three ground colours, accent spent only on focus and the
one affirmative action.**

- **Two chrome themes**, each redeclaring the full token set: `graphite` (dark
  neutral, the default a fresh install paints) and `paper` (light). Selected by
  a `[data-theme]` attribute on the root, never by a media query — a "System"
  preference resolves to one of the two *before* the attribute is written. A
  stored pick for a retired theme remaps on read (`RETIRED_CHROME_THEMES` in
  `theme.ts`) rather than falling through to the default, so a light pick never
  flips to dark.
- **Elevation is deliberately non-flat, and inverted from the usual card model.**
  The rail is *lighter* than the app canvas, and the terminal canvas is the darkest
  surface of all. Each pane reads as a lit screen recessed into the shell.
- **Surfaces are materials, not colours**, and materials come as a ladder — base,
  shell, inset, raised, overlay. Ask for a step, not a hex. Each rung carries its
  own ground, border, shadow and quiet ink, and its own measured receipt.
- **Selection and hover are achromatic** — a white/black overlay at 10%/5% alpha,
  never an accent tint. Accent appears in exactly two places: focus rings and the
  primary (or destructive-primary) action.
- **Status colour is a small, fixed vocabulary** — ok / warn / stop, plus info.
- **The background is one field** — in Custom mode, a single dithered image behind
  the whole window. The canvas and gutters let it through raw; the chrome (rail,
  titlebar) and the terminal panes stand on it under a scrim of their own. Solid
  stays the default.

When in doubt:

- Reach for a **neutral surface + border** before reaching for colour.
- Reach for a **CSS variable** before hardcoding a hex.
- Reach for a **rung on the material ladder** (`material.ts`) before writing a
  ground, a border and a shadow.
- Reach for an **existing chrome constant** (`buttonChrome.ts`, `overlayChrome.ts`)
  before writing a new class string.
- Reach for the **28px control floor** before inventing a height.

## Source of truth

| Concern | Canonical location |
|---|---|
| All colour, radius, spacing, type-scale, motion and metric tokens | `ui/src/renderer/src/theme.css` |
| Tailwind `--color-*` bindings (what makes `bg-surface` compile at all) | `ui/src/renderer/src/tailwind.css`, `@theme { … }` block |
| Keyframe catalog (`menu-in`, `panel-in`, `backdrop-*`, notice entrances…) | `ui/src/renderer/src/keyframes.css` |
| Element-level base rules (focus ring, disabled, `.btn` box) | `ui/src/renderer/src/base.css` |
| Button chrome | `ui/src/renderer/src/components/buttonChrome.ts` |
| The material ladder (rungs and their recipes) | `ui/src/renderer/src/components/material.ts` |
| Overlay/elevation chrome | `ui/src/renderer/src/components/overlayChrome.ts` |
| Select trigger chrome | `ui/src/renderer/src/components/selectChrome.ts` |
| The only import surfaces for icons, dropdowns and hover labels | `components/{icons,Select,Tooltip}.tsx` |
| Terminal palettes (separate axis from chrome) | `ui/src/renderer/src/theme.ts` |
| Enforcement | `bun run check:css`, `scripts/check-icon-imports.sh`, `scripts/check-icon-metrics.sh`, `scripts/check-title-tooltip-guard.sh`, `scripts/check-native-select.sh` |

`theme.css` is **unlayered on purpose**, so its `:root` beats Tailwind's `@theme`
defaults. That is why Houston's own scales are prefixed (`--tr-radius-*`, `--tr-text-*`):
the unprefixed names *are* Tailwind's, and redefining them silently resizes every
`text-*` / `rounded-*` utility in the app. Never add an unprefixed `--radius-*`,
`--text-*`, `--leading-*` or `--tracking-*`. Never hardcode a hex when a token covers
the role; a new token goes into **both** theme blocks, then into
`tailwind.css`'s `@theme` block if it needs a utility.

## Color roles

Tokens come in surface/foreground pairs. Use them together.

### Surfaces

| Token | Role | Don't use it for |
|---|---|---|
| `--content-bg` (`--background`) | App canvas, the ground everything sits on | Panels, popovers |
| `--rail-bg` (`--panel`) | The rail and the topbar — *lighter* than the canvas | Content panes |
| `--card-bg` (`--surface`) | Panels, pane chrome, cards lifted off the canvas | The canvas itself |
| `--card-hover` (`--raised`) | The RAISED/OVERLAY floating tier, and card hover | Inline UI |
| `--tool-code-bg` | Terminal canvas, code blocks, diff bodies, URL inputs — the darkest surface | App chrome |
| `--elevated-surface` | A card that must read above its own parent card | A replacement for `--raised` |
| `--overlay` | Modal scrim only | Any painted surface |

### Text tiers

| Token | Use it for |
|---|---|
| `--text-primary` | Titles, active rows, values the user is reading |
| `--text-secondary` | Sub-labels, unselected segmented items, supporting copy |
| `--text-muted` | De-emphasized chrome, placeholders, icon-button rest colour |
| `--text-faint` | The quietest tier — timestamps, disabled captions |

There is no `--ink-*` family. `--text-*` is the naming.

### Borders

| Token | Use it for |
|---|---|
| `--border` | Every ordinary hairline: card edges, input outlines, control borders |
| `--border-hover` | The same hairline under hover |
| `--divider` | Row separators *inside* a container — deliberately fainter than `--border` |
| `--hairline` | The divider equivalent on a custom surface |
| `--border-focus` | The active-pane ring. A luminance step, no hue |
| `--border-active` | An accent-mixed border for a control that is genuinely "on" |

### Accent

`--accent` / `--accent-ink` / `--accent-hover` / `--accent-muted`, aliased as
`--primary` / `--primary-foreground`. Accent is for **focus rings and the single
affirmative action** — not a hover colour, not a selection tint, not decoration. A
filled accent button pairs with `text-white` verbatim: the fill is a fixed contrast
pair, not a themed surface.

### Status

`--ok` / `--warn` / `--stop` are the canonical trio; `--online` / `--warning` /
`--danger` are aliases kept for existing consumers — prefer the trio in new code.
`--info` is the fourth, non-alarming member (a blue/cyan), used for "settled,
nothing wrong."

`--status-{doing,todo,blocked,done}-{bg,text}` are the pill pairs: doing→info hue,
todo→warn, blocked→stop, done→ok, background at a 14% mix.

AgentStatus (four values only) maps as:

| Status | Token | Motion |
|---|---|---|
| `spawning` | `--accent` | pulses |
| `working` | `--ok` | pulses |
| `idle` | `--info` | static |
| `needs-input` | `--warn` | static |

`needs-input` is static on purpose: it is settled-until-addressed, not transient.
Only the two genuinely indeterminate states move.

### Provider brand marks, diff and tool colors

Every provider Houston can spawn has a brand token, in two tiers. **Chromatic** marks
carry a colour as part of the trademark — `--claude`, `--antigravity`
hold the same hex in both themes, because a brand mark is not a themed
surface. **Monochrome** marks are black-on-light / white-on-dark by design, so
`--codex`, `--opencode`, `--cursor`, `--grok` resolve to `var(--text-primary)`:
following the theme *is* brand fidelity for them, and freezing a hex instead is
how `--codex` spent releases near-invisible on Paper. Tokens are opt-in via the
`brand` prop on an icon; everything else stays `currentColor`. `--text-muted` is
reserved for the non-provider kinds (shell, ssh, the ACP long tail) — it reads as
"generic engine" and must never be a provider's tint.

Resolve a provider mark by looking at it, never by filename: icon sets file the
**Gemini crypto exchange's** "G" under `gemini.svg` and Google's four-point spark
under a former product name. Houston shipped the exchange's logo for several releases
on exactly that mistake; `icons.agentMarks.test.tsx` now pins the shape.

`--tool-add-bg` / `--tool-add-text` (ok-tinted) and `--tool-remove-bg` /
`--tool-remove-text` (stop-tinted) carry diff and tool add/remove semantics, and
nothing else.

### Custom background

**The background is a field, not a sheet.** In Custom mode (`[data-custom='on']`,
Settings ▸ Appearance ▸ Background) one image — the user's own, or a preset — is
ordered-dithered and painted as a single field behind the whole window: the rail,
the topbar, the gutters and the terminal panes all stand on it. There is no
window-spanning glass sheet any more and no `backdrop-filter` in the chrome. The
tint a sheet used to carry now lives on the rung that wears it: under
`[data-custom='on']`, `--material-shell-bg` becomes `--custom-chrome-scrim`,
`--material-base-bg` goes transparent, and the two quiet ink steps are re-scoped
to the cuts each theme made for the field's ground. `--pane-gutter` widens to
16px and `--divider` becomes `--hairline` — a custom surface draws no opaque gash
over the field's bright end.

**Only the window chrome left glass.** The overlay tier — `raised-glass` and
`overlay-glass`, the popovers, menus, modals and command palette — is untouched
and keeps its `backdrop-filter` and its `--glass-blur` / `--glass-saturate` /
`--glass-bg` / `--glass-brd` tokens. Translucency did not go away; it stopped
being a window mode. Adding a second blurred layer anywhere is still a design
change, for the reason it always was: `backdrop-filter` clamps its sample to its
own element's box, so two adjacent glass boxes blur different slices and meet at
a visible step.

**The field is bounded, so chrome legibility stays provable.** The dither clamps
its output into a luminance band (dark themes cap the bright end, paper lifts the
dark end), and because blur, tint and scrim are monotone, a flat field at the
band's edge brackets every legal image — so the gate proves chrome ink against a
picture it has never seen, at the band, rather than against a shipped `.webp`.
The two quiet inks and the `-custom-worst` receipts follow the field's own
ground, measured per rung the way the sheet's used to be.

**Chrome ink is proven; terminal ink is shown, not proven.** Chrome ink can be
re-scoped when its ground moves and the gate holds the number. Terminal ink is the
agent's own ANSI palette — repainting it would make the terminal stop being a
terminal — so the terminal scrim dial renders its live contrast ratio beside
itself, next to the opaque ratio it is spending, instead of clamping it. The limit
a user can hit is a limit they must see.

**The content corner is a hole, so it is masked, not rounded.** `border-radius`
rounds a box's own outside, and the corner where the rail and the topbar meet the
content region is the hole those two surfaces leave. It is painted chrome into a
corner square with a quarter-circle masked back out (`.grid-region::before`,
`.agents-region::before`). The radius is concentric with the pane inside it —
outer = inner radius + the gap, written as the `calc()` — so the curve stays
parallel to the pane's instead of cutting across it. It paints `--material-shell-bg`,
which is why it needs no mode branch: in Solid that token is the rail's own fill
and the corner is invisible, and a mode that redeclares the token gets the corner
for free.

### Mixing

Need a tint? `color-mix` against an existing token, never a new hex —
`color-mix(in srgb, var(--danger) 14%, transparent)`.

## Typography

| Family | Token | Use |
|---|---|---|
| Plus Jakarta Sans | `--font-sans` | All chrome and body text |
| JetBrains Mono | `--font-mono` | Paths, fingerprints, IDs, terminal-adjacent UI — **machine values, never emphasis** |
| Source Serif 4 | `--f-serif` | Display only: empty states, onboarding, About. Never in chrome, menus, chips, tables or pane headers, and never below 20px |

All three are self-hosted; there is no network font fetch at runtime. Serif ships
weights 400/500/600 only — display-only means 700 has no consumer.

### The semantic scale

Eight steps, each with size + weight + tracking-or-leading. Use the step, not a
pixel value.

| Step | Size | Weight | Tracking / leading | Use |
|---|---|---|---|---|
| `display` | 44px | 500 | family = `--f-serif` | Empty states only |
| `title` | 30px | 700 | -0.02em | Page titles |
| `heading` | 22px | 700 | -0.014em | Panel headers |
| `subhead` | 17px | 600 | -0.006em | Settings groups |
| `body` | 15px | 400 | leading 1.6 | Body copy, transcript prose |
| `ui` | 13px | 500 | leading 1.5 | List rows, table cells, menu items, buttons — **the workhorse** |
| `small` | 12px | 500 | leading 1.45 | Chips, pane headers, secondary metadata |
| `label` | 11px | 700 | tracking 0.1em, `uppercase` | Rail group heads, table heads |

Tokens are `--tr-text-<step>-{size,weight,tracking,leading,family,transform}`
(`theme.css`). A parallel numeric scale `--tr-text-{xs…3xl}` exists for older
sites; new work uses the semantic steps.

**Label rule:** uppercase always pairs with tracking, and never appears below 11px.
An uppercase run with default tracking is a bug. So is the reverse: the `label`
step's 0.1em on a title-case run spaces a word out until it reads as a
different typeface. `scripts/check-label-tracking.sh` enforces the pairing.

Body base is **13px / weight 500**, set on `<body>` (not `<html>`) so rem-based
metrics elsewhere don't shrink; 400 reads too light for chrome. Digits that must
line up get `tabular-nums`, and numeric table columns right-align.

## Spacing & control metrics

A 4pt scale, nine steps, in `ui/src/renderer/src/theme.css`:

```
--space-1: 4px    --space-1-5: 6px    --space-2: 8px
--space-2-5: 10px --space-3: 12px     --space-4: 16px
--space-4-5: 20px --space-5: 24px     --space-6: 32px
```

The half-integer steps have specific jobs: `--space-1-5` is the icon↔label gap inside
a chip, `--space-2-5` the gap between chips in a cluster, `--space-4-5` fills the
16→24 jump. Row padding is `--space-2` for dense controls (Select options, segmented
items) or `--space-3` for table cells and settings rows. Control metrics, same file:

| Token | Value | What it measures |
|---|---|---|
| `--h-titlebar` | 28px | OS-frame titlebar, pre-boot screen only |
| `--h-top` | 44px | Live app topbar |
| `--h-railhead` | 44px | Rail brand-mark row — equal to `--h-top` so both land on the same pixel row |
| `--h-pane-head` | 28px | Every pane header, everywhere |
| `--h-ctl` | 28px | Buttons, selects, inputs |
| `--h-row` | 28px | List and table rows |
| `--h-pill` | 26px | Chips |

**Every interactive target stays ≥28px tall**, regardless of its visible box — a 22px
icon button is fine only inside a 28px hit area. `--shell-zoom` mirrors the live zoom
factor; chrome that must stay OS-constant (window controls) divides by it.

**A stack's rhythm belongs to its container.** Put `gap-*` on the flex or grid parent;
never a `mt-`/`mr-`/`mb-`/`ml-` on the children, at any value. `ml-auto` is alignment,
a `-0` is a reset of somebody else's margin, and a negative margin is a pull into
overlap — those three stay legal. Every other directional margin is one element
deciding a number its parent should own, which is how a row of badges drifts out of
step with the row it sits in. `check-spacing-tokens.sh` holds the line against a
per-file ratchet; prose rhythm inside a `[&_…]:` variant is exempt, because
markdown output has no JSX parent to carry a gap and its steps are deliberately
uneven.

## Radius

Six values, in `ui/src/renderer/src/theme.css`:

| Token | Value | Meaning |
|---|---|---|
| `--tr-radius-input` | 4px | Inputs, select triggers |
| `--tr-radius-sm` | 6px | Chips, small tiles, menu option rows, inputs, badges, banners, mini icon buttons |
| `--tr-radius-button` | 8px | Buttons, segmented track |
| `--tr-radius-md` | 10px | Panes, overlays, modals, the command palette |
| `--tr-radius-card` | 12px | Cards |
| `--tr-radius-pill` | 9999px | Full capsule |

**The rule: rounded = a value, capsule = pressable.** A status pill, a tag, a count
badge is a *value* and gets a rounded radius. A segmented group, a filter chip, a
removable chip is *pressable* and gets the full capsule. Getting these backwards is
why some interfaces have controls that don't read as controls.

Match the neighbouring primitive rather than introducing a new step.

**One source, and a guard that keeps it that way.** A call site names the rung —
`rounded-[var(--tr-radius-button)]`, `border-radius: var(--tr-radius-md)` — never
the number. `.btn` (base.css) and the icon-button chrome constants read the tokens
too, so changing one `--tr-radius-*` and rebuilding moves every surface wearing that
meaning. `check-radius-tokens.sh` refuses a `rounded-[Npx]` literal, a
`border-radius: Npx` in CSS, and the framework's own `rounded-sm`/`md`/`lg`/`xl`
(unmapped in `tailwind.css`'s `@theme`, so they are the framework's scale, not this
one), against a per-file ratchet that only shrinks. `rounded-full` and `rounded-none`
stay legal: a circle and a zero are shapes, not rungs.

## Materials

Surfaces are materials, not colours. Materials come as a **ladder**, so "one step
more separated" is a step on an axis rather than a new hex. Five rungs, in
`ui/src/renderer/src/components/material.ts`:

| Rung | Ground | Border | Shadow | For |
|---|---|---|---|---|
| **base** | `--content-bg` (Custom: nothing — the field) | — | — | The canvas: the Agents gutter, a pane column's ground |
| **shell** | `--rail-bg` (Custom: `--custom-chrome-scrim`) | — | — | The app's own frame: rail, titlebar, the grid container |
| **inset** | `--card-bg` | `--border` | — | A box cut into what it sits on: cards, panels, list surfaces |
| **raised** | `--raised` | `--border` | `--shadow-1` | Menus, dropdowns, hover previews, toasts |
| **overlay** | `--raised` | `--border` | `--shadow-2` + a sibling scrim | Modals, confirm sheets, popovers, the command palette |

`raised` and `overlay` each have a translucent twin — `raised-glass` and
`overlay-glass` — which is the same step with a 90% film instead of an opaque
fill. That film is the overlay tier's own, chosen per call site; it is not a window
mode. **The ladder adds tint rungs, never blur rungs**: those two
carry the only `backdrop-filter` in the set, it is the same one the overlay tier
carried before the ladder, and the number of simultaneously live blurred layers
is not allowed to rise. A rung wanting its own blur is a design change.

`shell` carries no border and no shadow because the rail's edge is a tonal step,
not a line — the divider is gone in every mode, and the step between `--rail-bg`
and the grid is what divides — and its cast shadow is a per-surface, per-theme
call (`--glass-rail-shadow` / `--glass-topbar-shadow`, none in every theme) —
geometry drawn where the surface is drawn, not a property of the material. `base`
is the ground and has nothing to be separated from. If something needs more
emphasis than `overlay`, it needs a focus ring, not a shadow. Panes never get drop
shadows.

**Wearing the rung is half the contract.** `data-material` is what scopes the
rung's ink (below), so the attribute travels with the class —
call sites spread `materialAttrs()` (`material.ts`) alongside `MATERIAL_CLS`,
and `overlayChrome.ts` ships an `…_ATTRS` object beside each `…_CLS`.

`--shadow-1` = `--shadow-md`, `--shadow-2` = `--shadow-lg`, both per theme (light
themes use shorter, softer throws). `overlayChrome.ts` composes the four overlay
tiers on top of the ladder — use a constant, don't hand-roll a shadow:

| Constant | Rung |
|---|---|
| `OVERLAY_RAISED_CLS` + `OVERLAY_RAISED_ATTRS` | `raised` |
| `OVERLAY_OVERLAY_CLS` + `OVERLAY_OVERLAY_ATTRS` | `overlay` |
| `OVERLAY_GLASS_RAISED_CLS` + `OVERLAY_GLASS_RAISED_ATTRS` | `raised-glass` |
| `OVERLAY_GLASS_OVERLAY_CLS` + `OVERLAY_GLASS_OVERLAY_ATTRS` | `overlay-glass` |

All four add the shared structure the ladder does not carry: `--tr-radius-md`,
`no-drag`, `select-text`, and a `motion-safe:` `menu-in` entrance. The scrim under
the `overlay` rung is a sibling element at the call site, not part of the class.

### A rung's own ink, and its receipt

Every rung stands on a different ground, so **each rung's two quiet inks are cut
against that ground rather than painted on it**. `theme.css`'s `[data-material]`
rules re-scope `--text-muted` and `--text-faint` per rung; the two louder inks
clear on every rung in both themes unlifted and are deliberately not redeclared.

The bar is one sentence: **a surface must not cost legibility.** Every rung's ink
clears `min(4.5, R)`, where R is the same ink's ratio on the ground that material
*replaces* — `base` for an opaque rung, the rung's own Solid form for a
translucent one. A step up the ladder never costs what the canvas gives, and
translucency never costs what the Solid form gives. `base` in Solid is the floor
and is what the others answer to.

That bar bit the first time it was applied: on Graphite the ladder climbs toward
its light ink, so `--text-muted` fell from 4.66:1 on the canvas to 4.37 on a card
and 4.00 on a menu — held by nothing until every rung had a receipt. On Paper the
ladder climbs away from its dark ink and every opaque step buys contrast instead,
so Paper cuts nothing opaque.

`--material-<rung>-worst` is that receipt: the worst ground the rung leaves under
ink. An opaque rung's is its own fill; the translucent ones are measurements.
None of them is a note — `check:css` renders **every** rung's shipped recipe over
the shipped backdrop at three window sizes, at the geometry the app gives it, and
fails the build on any receipt more optimistic than the pixels. It reads the rung
list out of `material.ts`, so a rung added there is measured and held with nothing
in the script edited.

## Layout anatomy

The shell is an **L-shaped CSS grid** — pure geometry, no state:

```
grid-template-columns: auto minmax(0, 1fr)
grid-template-rows:    var(--h-top) 1fr
grid-template-areas:   "rail topbar" "rail grid"
```

The rail spans both rows (full height); the topbar spans the content column only.
There is no status bar row — diagnostics live in Settings.

| Region | Metric / rule |
|---|---|
| **Rail** | Resizable between 200 and 420px, remembered per user; `sidebarRail` also hides it, and dragging under 160px collapses it. When hidden, a "Show sidebar" icon button appears in the topbar's left cell. Rail head is 44px; nav rows are ≥28px; Settings section rows are 36px. Selection is one class: an achromatic full-row fill plus `--text-primary` — no left bar, no accent tint. |
| **Topbar** | 44px. Two-column grid: left = sidebar toggle, right = voice chip → Tidy-panes → notifications → Source control → window controls. The Agents/Code mode `Segmented` floats at the window's centre, a child of the shell root. Drag region; interactive children opt out with `no-drag`. |
| **Window controls** | Ordered from the desktop's own button-layout setting, not a hardcoded cluster. Monochrome, no hue-coded discs, no reserved gutter. Sized in `calc(… / var(--shell-zoom))`. |
| **Terminal grid** | Panes are absolutely positioned inside one container; geometry is computed as percentages then converted to pixel-gutter `calc()`. Outer margin **8px**, **4px** per shared interior edge. Splitters are 8px hit strips centred on the seam; keyboard nudge is 4% of the span. Expand-to-full hides siblings by `visibility`, it does not unmount them. |
| **Pane headers** | 28px, every pane kind — session, editor, files, browser, skills. |
| **Stack tabs** | 26px strip on `--card-bg` with a `--divider` bottom border. Each tab: status dot + truncated label (110px cap) + optional 6px `--warn` needs-input badge + a hover/focus-revealed close button. Active tab drops to `--content-bg`; inactive is muted with a neutral hover wash. A `n/cap` indicator appears at the stack's cap. |
| **Source control** | A workspace panel beside the grid, with Changes and Pull request tabs. Preferred width 480px, compact minimum 340px; expansion is bounded by the main content width, reserving 360px for terminals when space permits. Smaller windows clamp the rendered width without replacing the remembered preference. Its divider uses the terminal splitter's hit area and neutral drag line. |
| **Changes tab** | Responds to **container queries, not viewport breakpoints**. Wide (`@container (min-width: 720px)`): file list beside the diff. Narrow: stacked, tree capped at 45% height. It has no pane header, drag affordance or independent grid cell. |
| **Settings** | One scrollable column; section nav lives **in the rail**, not inside the view. Column max-width **720px**, and **1040px** for the data-dense Usage section only. Rows are grouped into one bordered card per group with internal hairline dividers, so a group reads as a single object with internal divisions. |
| **Notices** | Two anchors. `workspace-top`: centred, `min(560px, 100% - 24px)`, **no enter or exit animation**. `pane-corner`: bottom-right, `max-w-[min(300px, 100% - 24px)]`, enters from its own corner and exits by unmounting. Rows are ≥30px with a kind glyph, title, optional mono body, and one action or a dismiss. |
| **Command palette** | Mounted only while open. Full-viewport scrim, panel `min(560px, 86vw)` at `max-h-[70vh]`, overlay glass, `--tr-radius-md`. 46px search header; `role="listbox"` with 32px option rows grouped under uppercase 11px headers. |

Source control belongs to the workspace, not to the split tree. Closing it must
not close or remount terminal panes. Settings and navigation surfaces cover the
same content region, including the panel. The panel's tabs use neutral selection;
accent remains reserved for focus and the affirmative action.

## Components

### Buttons

There is no `<Button>` wrapper. Buttons compose the `.btn` base class (28px box,
`--tr-radius-button`, 12px/500 label) with a chrome constant from `buttonChrome.ts`.
A `<button>` with no `.btn` renders **bare on purpose**, so a forgotten opt-in is
visible rather than silently defaulting to a bordered card.

| Constant | Use |
|---|---|
| `BTN_PRIMARY` | The single affirmative action in a flow |
| `BTN_DANGER_SOLID` | The irreversible action — same *rank* as primary, differing only in consequence. Always paired with a warning icon; colour alone is not a signal |
| `BTN_GHOST` | The ordinary case: transparent fill, muted label, no border |
| `BTN_GHOST_BG` | Ghost's background half only, for sites that must inherit their text colour |
| `BTN_GHOST_DANGER_HOVER` | Hover-only danger cue: a destructive click with no standing risk before it |
| `BTN_GHOST_DANGER_ARM` | Standing danger cue: an armed, click-again-to-confirm control |
| `BTN_ICO` | Full icon-button chrome (24×22 box, `--tr-radius-sm`, muted→primary on hover) |
| `BTN_ICO_STRUCTURE` | Bare structure only, for sites that bring their own size and colour |

Ghost's `border-none` is a real border-*style* reset, so a later `border-color`
utility paints nothing — danger cues signal through fill + text, never a border.
**Cancel, Dismiss, Close and Discard are not destructive.** They back the user out
and stay quiet: `BTN_GHOST`, no colour, no keyboard chip. Save the weight for the
affirmative action.

### Select

Every dropdown is `components/Select.tsx`. **Native `<select>` is banned** — its
open popup is a separate OS window that the desktop toolkit draws with its own font
and its own selection fill, so none of our tokens reach it.

The trigger is `SELECT_CLS` (28px, `--tr-radius-input`, `ui` type size). The menu
uses `OVERLAY_RAISED_CLS`, caps at 320px with a 4px gap and an 8px viewport margin,
and flips/clamps to stay on screen. Option rows are `--h-ctl` tall at
`--tr-radius-sm`; the selected row's checkmark sits in a fixed gutter so labels never
shift. Type-ahead, Home/End, arrows, Enter/Space, Tab-commits and Escape-restores are
all implemented — extend it rather than rolling a listbox.

### Tooltip vs `title`

`components/Tooltip.tsx` is the only hover label. It portals to `document.body` so no
`overflow: hidden` ancestor clips it; 300ms hover delay, bypassed by keyboard focus;
6px offset, 8px viewport margin; flips vertically, clamps horizontally; dismisses on
Escape, pointerdown, scroll, resize and blur.

- **Use one when** an icon-only button or a truncated label needs a name.
- **Don't** when the control already has a visible label, or when the message is
  critical — errors and blocking warnings go inline.
- **Never pass both `label` and a native `title`** on the same child; they double
  up. Converting a call site means deleting its `title`.
- A `title=` prop on a capitalized component is only legitimate when it is *visible
  heading text*. The guard script keeps the allowlist.

### Modals

`ConfirmModal`, `SaveDiscardModal`, `HostKeyModal` and `SshConnectModal` share one
scrim + `.pop` panel shell; **only the width differs** (380 / 380 / 460 / 420px,
always `max-w-[92vw]`). The scrim is `--overlay` + a light backdrop blur and cancels
on mouse-down; the panel is `--raised` + `--shadow-2` + `--tr-radius-md` with a
`panel-in` entrance. Footer grammar: ghost Cancel left of the affirmative action; a
three-way choice reads Cancel (ghost) · Discard (ghost + standing danger) · Save
(primary). Focus starts on the safe choice, Escape backs out, and more than two
controls means a full focus trap.

### Chips, badges and tiles

`Chip` has five variants (`state`, `provider`, `count`, `compound`, `removable`) and
five tones mapped onto the status pill pairs. Shell: 26px, `--space-2` padding,
`small` type. Radius follows the meaning rule — `removable` or clickable → capsule,
everything else → `--tr-radius-sm`. `selected` is the one place a chip may use
`--accent-muted` + an accent border, because a chip is a compact affordance rather
than a full row. A `count` chip distinguishes "no value yet" from a known zero —
render an empty-set label, never a bare `0`, for the latter. `IconTile` comes in
24/32/40px with the same tone map; its interactive variant adds a hover wash and a
small active scale.

### Segmented control

A 28px track at `--tr-radius-button` over a 4%-mixed background; 22px items, 54px
minimum width, 12px label. Selection **cross-fades colour and background; it does not
slide a thumb.**

### Tables

`DataTable`: sticky opaque `thead` on `--surface`, row hairlines on `--divider`
(never `--border`), 28px rows, numeric columns right-aligned with `tabular-nums`,
default body height cap 360px, and empty/loading/error states rendered inline in
`tbody` rather than replacing the table. `DefinitionTable` is a lookup surface, not a
form: a 160px label column on `--panel` with a small muted icon tile, a mono value
column with optional middle-truncation, and masked rows for secrets — the masked
value never touches the DOM in full and there is no reveal control.

### Menus

Context/submenu panels are `fixed`-positioned (host menus clip with
`overflow: hidden`), `min-w-[170px]`, `--raised` + `--shadow-1` +
`--tr-radius-md`. **In menus, disabled beats hidden** — an empty submenu renders one
disabled row rather than vanishing.

**A menu item's description line wraps or truncates on purpose.** Use
`whitespace-normal`/`line-clamp-N`, or `truncate` paired with an explicit
`max-w-*`; never `whitespace-nowrap` or `truncate` with no bound, and never a
description with no wrapping class at all — that reads fine on the string
tested against and overflows the panel on the next one.
`scripts/check-menu-descriptions.sh` enforces it.

### Icons

`components/icons.tsx` is a **hand-drawn SVG library** — roughly 92 `Icon*`
components that reproduce Lucide's geometry (each citing the glyph it copies), with
no runtime dependency on any icon package. `lucide-react` is never imported.

- Shared wrapper: `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`,
  round caps and joins, default `size={14}`, `strokeWidth={2.5}`, and automatic
  `aria-hidden` unless the caller supplies an aria/role prop.
- **No call site passes `size` or `strokeWidth`.** Both come from the icon rung
  matching the TEXT the glyph sits beside — eight rungs, the same eight names as
  the type ladder, resolved in CSS from `--tr-icon-<rung>-size` (as the svg's own
  `font-size`, with a `1em` box) and `--tr-icon-<rung>-stroke`. Render
  `<Icon glyph={IconFoo} role="ui" />`; where wrapping would break the DOM — a
  glyph held in a `Record`, passed as a prop, or carrying its own `className` —
  resolve it through `resolveTightGlyph(Glyph, role)` (Icon.tsx) before
  rendering it bare with `ICON_ROLE_CLS[role]` as its class, or the tight cut
  below never reaches it. Inside a control, ask
  `CONTROL_SIZE_ICON_ROLE` (regular→`ui`, small→`small`, mini→`label`) rather than
  re-deciding. `scripts/check-icon-metrics.sh` refuses either prop, everywhere.
- The ladder runs 26/1.4 at `display` down to 11/2.8 at `label`: stroke moves
  OPPOSITE to size, because a small glyph needs a heavier line to read at all.
  Retuning a rung in `theme.css` moves every glyph on it.
- Colour inherits from surrounding text; brand colour is opt-in via the `brand`
  prop, and only for provider marks.
- Need a glyph that doesn't exist? Add it in the house geometry — don't import one.
- A glyph that fails at 11px gets a real second drawing in `TIGHT_ICON_MAP` (icons.tsx) plus the rung tokens above — not a hardcoded per-element `strokeWidth` pair like the pre-existing `IconHouston`/`IconHoustonSmall`.

### Drop indicators

Every drop target in the app wears the same clothes: a **2px dashed
`--accent` stroke over a 10% accent wash**, at `--tr-radius-md`, entering on
`term-enter`. Two of them exist — the terminal's file dropzone
(`pane/TerminalPane.tsx`) and the pane-drag zones (`LayoutView.tsx`) — and a
third must match rather than invent a look.

**A drop zone names its action.** Where a target has more than one outcome, the
band carries a chip saying which — `Split left`, `Split down`, `Swap`, `Stack`
— in the same words the pane header's menu uses. The chip is an accent fill
with `text-white` (BTN_PRIMARY's fixed contrast pair) because it sits over live
terminal output, where accent ink on a 10% wash cannot be read. It reads the
drop target itself, never a pre-resolved string, so it cannot promise one thing
and do another: a held modifier that changes the outcome changes the chip.

**The band does not slide between zones.** Discrete zones cross-fade or cut, for
the reason the segmented control does not slide a thumb — animating
`inset`/`width` is neither transform nor opacity (Motion rule 1).

**The dragged element dims behind a scrim, not with `opacity`.** `bg-overlay`
above the pane's own chrome. Fading the element itself fades its text and
borders along with it, and a pane you are placing is one you still want to
recognise.

## States

| State | Treatment |
|---|---|
| **Focus (keyboard)** | Element-level, applied once for `button`, `select` and `input`: `outline: 2px solid var(--accent); outline-offset: 1px` — so no site can forget it. A site with its own ring still wins by utility order. |
| **Focus (halo)** | The composite ring used on chips and tiles: `0 0 0 2px var(--background), 0 0 0 3px var(--focus-ring)`. `--focus-ring` is its **own token**, deliberately not `--accent`, because that hue already means "primary action." |
| **Hover** | `--hover-fill`, an achromatic 5% overlay, for rows and rail items. Buttons use `--border-hover` / `--card-hover`. Ghost-danger buttons get a hover-only tint. |
| **Disabled** | Element-level `opacity: 0.45; cursor: not-allowed`. Controls repeat `opacity-45` locally where they need it. Disabled controls still carry a reason where one exists. |
| **Selected** | `--selected-fill`, an achromatic 10% overlay. Full-row fill, no left bar, no accent tint. `Chip`'s `selected` is the documented exception. |
| **Active pane** | `--border-focus` — a plain luminance-step ring, a header lift to `--raised`, and the pane's own name held at `--text-primary` while every other pane's name steps to `--text-secondary`. **No hue** in any of the three: a coloured stroke or ink would clash with whichever terminal palette the agent underneath is using. The pane body — the terminal itself — never changes on focus. |

## Motion

Four named curves, `--motion-{fast,menu,panel,scrim}-{t,ease}` in `theme.css`. Nothing
should reach past them for a new site.

| Curve | Duration | Easing | For |
|---|---|---|---|
| Fast | 120ms | `cubic-bezier(.2, 0, .38, 1)` | Micro-transitions, hovers |
| Menu | 160ms | `cubic-bezier(.16, 1, .3, 1)` | Menus, dropdowns, popovers |
| Panel | 240ms | `cubic-bezier(.32, .72, 0, 1)` | Panels sliding from an edge |
| Scrim | 90ms | `linear` | Backdrops — always the fastest thing on screen |

The `--animate-*` names are back-compat aliases; each points at whichever curve its
site's *purpose* is, not at whatever its old literal happened to compute to.

The rules:

1. **Transform and opacity only.** Animating `box-shadow` is forbidden — express the
   same visual as `transform: scale()` + `opacity` on a pseudo-element.
2. **Exits are faster than entrances.** Enforced at the call site: enter at Menu,
   exit at Fast.
3. **Motion communicates origin.** A toast enters from the corner it lives in, not
   from nowhere.
4. **Nothing loops but a genuine indeterminate.** Only `working` and `spawning`
   pulse; a running process has no known end time. `needs-input` is static.
5. **Reduced motion shows a settled frame, not a broken one.** Under
   `prefers-reduced-motion: reduce`, a pulse jumps to its mid-pulse frame rather
   than disappearing.
6. **Everything is `motion-safe:`-gated.**
7. **No animation library.** Interruptible springs, layout tracking and gesture
   physics are exactly what rules 1–4 forbid; there is no Framer/Motion dependency.
8. **Panes get no drop shadow, no per-pane accent hue, and no animated entry.**

Keyframes live in `keyframes.css` — global and unlayered by necessity, since Tailwind
utilities name them directly.

## Accessibility conventions

- Every icon-only control carries an `aria-label` or a `Tooltip`, and usually both.
- Custom widgets carry real roles: `combobox` + `listbox`/`option` +
  `aria-expanded` / `aria-controls` / `aria-activedescendant` for Select, `dialog`
  for modals, `alertdialog` for destructive confirms, `menu`/`menuitem` for menus.
- **Escape closes.** Every overlay, menu, popover and modal handles it, each with its
  own local handler — there is no shared priority list, and the one place a
  coordinated chain exists (`App.tsx`'s global keydown handler) only runs while no
  pane is focused. See renderer.md's [Tab order](renderer.md#tab-order)
  section for the exact chain and its one exception (a focused terminal pane, where
  Escape passes straight through to the PTY).
- **Arrow keys navigate** anywhere a list is selectable: the rail, Select, the
  palette, the changes list. Not yet the pane grid or `StackTabs`' tab strip — both
  are still plain sequential Tab stops (`StackTabs` gives every tab its own
  `tabIndex={0}` rather than a roving one), unlike `FilesPane`, `ChangesPane` and
  `Segmented`, which do implement real roving tabindex.
- **Focus restores on close.** Capture `document.activeElement` on open, `.focus()`
  it back on dismiss. True of every hand-built modal in the codebase (`ConfirmModal`,
  `SaveDiscardModal`, `HostKeyModal`, `SshConnectModal`, `CommandPalette`,
  `BrowserActConfirm(Modal)`, `HandoffOverlay`'s modal variant) — each implements
  this itself; there is no shared `Modal`/`Dialog` primitive that provides it for
  free, so a new dialog needs the same capture/restore added by hand.
- Errors surface via `aria-invalid` on the control, not a hand-painted red border.
- Colour is never the only signal — the destructive button carries an icon, status
  dots carry tooltips, needs-input carries a badge as well as a hue.
- Contrast floors are gated: `--text-primary` on `--background` ≥4.5:1 in every
  theme, `--focus-ring` ≥3:1 against both `--surface` and `--raised`.

## Terminal palettes

Terminal colour is a **separate axis** from chrome. There are 24 named presets, each
a flat object (background, foreground, cursor, cursor accent, selection background,
plus 16 ANSI colours), applied directly to the terminal engine — never through chrome
CSS variables, never scoped by `[data-theme]`. Each is classified light or dark for
auto-pairing, and each chrome theme has a default pairing chosen so the pane plate
never seams against its canvas:

| Chrome theme | Default terminal palette |
|---|---|
| `graphite` | `black` |
| `paper` | `marble` |

Any palette pairs with any chrome theme, so never assume the terminal background
matches a chrome token — that is why the active-pane ring is achromatic.

## Guards

Eleven checks enforce this guide mechanically. The idiom is hermetic, sub-second checks
wired into CI; `check:complexity` is the one exception, and it earns it by measuring
something no text search can count (see "A closure is not a fix").

| Check | What it enforces |
|---|---|
| `bun run check:css` | Runs a headless browser against the **built** stylesheet (`@theme`/`@layer` only resolve after a build). Re-derives the theme list and the `--color-*` → `--X` mapping from source rather than hardcoding them, then asserts every `--color-*` re-resolves under each `[data-theme]` scope. Also asserts the contrast floors above. |
| `scripts/check-icon-imports.sh` | Bans `lucide-react` imports outside `components/icons.tsx`. Its allowlist is currently empty — the rule holds with zero live exceptions. |
| `scripts/check-title-tooltip-guard.sh` | Flags any capitalized JSX component receiving `title=` that isn't on the visible-heading allowlist. A `title` that means "tooltip" fails. |
| `scripts/check-native-select.sh` | Bans `<select` anywhere under `ui/src` outside `components/Select.tsx`. Strips comments first, so prose mentions don't false-positive. |
| `scripts/check-native-input.sh` | Bans `<input type="checkbox">`/`<input type="radio">` anywhere under `ui/src`. No exemptions — `Toggle` and `Segmented` (`components/settingsPrimitives.tsx`) cover both shapes. |
| `scripts/check-menu-descriptions.sh` | A menu item's description line (the `<span>`/`<small>`/`<p>` after its `<strong>` label inside a `role="menuitem"` block) must wrap or truncate on purpose — never `whitespace-nowrap`/`truncate` with no `max-w-*` bound, never no wrapping class at all. |
| `scripts/check-icon-metrics.sh` | Bans a `size=` or `strokeWidth=` prop on any glyph under `ui/src`, and props objects that spell one. No baseline and no allowlist: `components/icons.tsx` (whose defaults define the drawn set) and `IconTile` (a container with a named tile scale, not a glyph) are the only exemptions. |
| `scripts/check-ellipsis.sh` | Bans ASCII `...` in user-facing text (`.ts`/`.tsx` string literals and JSX text, plus `index.html`) — the real ellipsis character (`…`) is the only spelling. Comments and test files are stripped first; spread/rest (`...args`, `[...arr]`) is excluded by what follows the `...`. No baseline. |
| `scripts/check-focus-visible.sh` | Bans a class string that turns `outline-none` on without repainting a `focus-visible:` state of its own (`shadow-`/`ring-`/`border`/`bg-`/a real `outline`). Per-file exemption count, ratchets down only. |
| `scripts/check-empty-state-action.sh` | An empty state must contain the control its copy names. Copy pointing at a button that lives elsewhere fails; a bare statement of fact ("No results.") passes. Three reasoned testid exemptions. |
| `bun run check:complexity` | Ratchets each component's cyclomatic complexity against `ui/complexity-baseline.json` (`worst` and `over`; `total` recorded beside them). Needs `bun install` — it shells out to a pinned `oxlint`, so it is not one of the hermetic scripts. See "A closure is not a fix" below. |

`check:css` needs a `bun run build` first; the rest are standalone and instant.

### A closure is not a fix

`check:complexity` measures cyclomatic complexity **per function**, and every
closure is its own function. So wrapping a block of JSX in a zero-arg arrow —
`const header = (): React.JSX.Element => (…)`, called as `{header()}` — moves
its branches off the component's score without changing a single thing that
executes. Three separate agents found that door unprompted in one afternoon; on
one file, nine such wrappers moved the reported worst score from 55 to 17 while
the file's total moved only 121 to 111.

That is not a refactor, and a review should refuse it. The test is the shape of
what comes out, not whether the number falls:

- **A fix** is a top-level function taking explicit arguments — a real sibling
  component with props, or a pure helper like `copyButtonChrome(state)`
  returning `{ label, icon, warn }`. It is callable and unit-testable without
  mounting anything, which is what makes the extraction worth having.
- **Not a fix** is a zero-arg closure capturing local state. Nothing became
  testable, nothing became reusable, and the only thing that changed is which
  function the linter charges.

The gate cannot tell these apart — a genuine sibling component moves branches
into a new function in the same file exactly as a sham closure does, and the
`total` it prints is the only tell. Reading that number is a person's job.
Extracting a hook is a third case again: worth doing for the seam it names, but
worth **zero** points, because a `useCallback`/`useEffect` body was never
charged to the component to begin with.

## Stacking

Fourteen tiers in `theme.css`. Every `z-index` in the app names one; a raw number
at a call site is a layer nobody can see from anywhere else, which is how 25
distinct values accumulated across 69 sites. Within a tier, `+1`..`+3` is a real
order between things that share a stacking context (a submenu over its menu); a
larger offset means the site wants its own tier.

| Token | Value | Layer |
|---|---|---|
| `--z-backdrop` | 0 | the custom field, under everything |
| `--z-base` | 1 | in-flow content that must beat its own siblings |
| `--z-pane` | 5 | grid splitter; `+1` dropzone, `+2` drop target, `+3` pane chrome |
| `--z-leaf` | 10 | a whole pane over its neighbours; `+1` notice, `+2` pane cover |
| `--z-sticky` | 20 | chrome floating over a scroll region |
| `--z-overlay` | 40 | a menu anchored to its trigger; `+1` its submenu |
| `--z-popover` | 45 | a popover panel |
| `--z-dropdown` | 46 | a select's list, which can open inside a popover |
| `--z-context` | 60 | a context menu, portalled, clears every panel below a dialog |
| `--z-modal` | 70 | a dialog and its scrim, and a menu opened from inside one |
| `--z-palette` | 80 | the command palette, above any dialog |
| `--z-window` | 100 | window furniture: the resize grips |
| `--z-toast` | 300 | a transient status banner over the whole window |
| `--z-tooltip` | 1000 | the hover label, and the browser's fullscreen cover |

## Known debt

Real, measured, and not yet fixed. Don't extend these; do fix them opportunistically
in files you're already touching.

Every entry here is a per-file ratchet: the guard names the file and its count,
and a count may only fall. The numbers move, so read them from the guard rather
than from this list.

- **Radius literals.** 49 files still spell a corner as a number or as the
  framework's own `rounded-*` scale. Nothing that reaches a `<button>` does —
  neither the tag nor any shared class constant it takes its chrome from,
  which is checked by cross-referencing the two rather than by a list. What
  remains is 8/10/6/4/12/999px on surfaces: each maps onto a rung by VALUE,
  but a 10px card means `--tr-radius-card`, not `--tr-radius-md`, so closing
  these is a reading of each site and not a substitution. Pinned by
  `check-radius-tokens.sh`.
- **Sibling margins.** 43 files set spacing on the child instead of `gap-*` on
  the container, 162 in all. Close to a third sit in the settings section,
  where no single parent owns the sequence — that one is a redesign, not a
  sweep. Pinned by `check-spacing-tokens.sh`.
- **Control-metric drift.** 19 files hold hand-typed heights, each already
  classified in code as something the ladder does not govern — a resizable
  editor, a growth cap on an auto-sizing composer, a content card, a
  structural strip, the menu-item height that has no rung. Pinned by
  `check-control-metrics.sh`.
- **Two button recipes out of place.** `ChangesPane` declares a private `BTN_*`,
  and a `BTN_GHOST` use in `settings/DiagnosticsSection.tsx` carries no `btn`.
  Named in `check-button-recipes.sh`'s allowlist, which fails when an entry
  goes stale.

## When this guide is silent

1. Look at the **nearest sibling component** in `ui/src/renderer/src/components/`
   and follow its lead — same icons, same heights, same submit semantics.
2. Check the **chrome constants** (`buttonChrome.ts`, `overlayChrome.ts`,
   `selectChrome.ts`, `panelChrome.ts`) for a recipe that already encodes the
   pattern.
3. If it's a token question, **`theme.css` is canonical** — use what's there, or add
   a new token to both theme blocks and expose it in `tailwind.css`'s `@theme`.
4. If two existing patterns contradict, prefer the one with tests and the one that
   landed more recently, and flag the other.
5. If none of those resolve it, **ask before inventing.**
