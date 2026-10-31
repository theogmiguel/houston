# Houston design B ("Native") rollout

Reference: `scratchpad/mocks/houston-mocks.html` (states switcher covers normal, offline, exited, long names, first run, narrow).

Success criterion: every harness story, in Graphite and Paper, matches the mock's tokens and recipes; all existing guards plus the new ones pass; `bun run typecheck`, `bun run test`, `check:css`, `check:bundle` green; full suites green under the memory guard.

## Decisions (settled)

| Decision | Choice |
|---|---|
| UI font | Inter Variable with optical sizing (`@fontsource-variable/inter` 5.3.0, OFL-1.1, ships `opsz.css`: opsz 14..32 + wght) |
| Display font | Source Serif 4 (already bundled) for empty states and first run only |
| Machine values | JetBrains Mono (already bundled); never for prose |
| Delivery | One branch, one PR, one commit per phase below; no Cut release until merged |
| Sidebar | "Expanded": workspace headers, grids as captions, every session a row, roll-up status on collapsed workspaces |
| Provider marks | Grey at rest, brand colour on hover and selection |
| Finished-unseen | Already renderer-only (`src/renderer/src/finishedUnseen.ts`); no protocol change |

## Decisions still open (tweak before phase 1)

1. Accent fill `#2f6fe8` (graphite) / `#0a63e0` (paper) replaces the current accent everywhere, including user-chosen theme accents? Proposal: only the default palette; custom accents keep their hue and get the fill/ink split computed.
2. Body weight 400 (from 500). Affects every surface; proposal: yes.
3. Row floor 28px (current rail rows vary; `Sidebar.treeRowHeights.test.tsx` pins them). Proposal: 28px rail rows, 36px list rows.

## MVP shortcuts (deferred, listed on purpose)

- Increase-contrast variants of the tokens: not in this PR (no OS signal wired today). Deferred: a `prefers-contrast: more` block.
- Word-boundary truncation: CSS ellipsis only. Deferred: a measured `truncateWords()` for rail titles.
- Usage page and PR panel get token updates only, no layout pass.
- Orchestrator overview (`components/ui/OrchestratorOverview.tsx`) adopts `StatusGlyph` but keeps its layout.

## Commits

### 0. Harness renders every story

The 125 `pr-panel/*`, `pr-page/*`, `prs/*` stories throw `Cannot read properties of undefined (reading 'forge')`. Root-cause in the story fixtures (candidate: `components/git/PullRequestTab.tsx` reads `.forge` from a fixture that omits it); fix the fixture to a state the daemon can produce, with a regression test that renders one `prs/*` story.

Move the capture script into the repo so before/after is reproducible:

```
scripts/capture-stories.mjs <outDir> [filterRegex]   # every story x {graphite,paper}, 1280x800
```

(Port of the scratchpad `shoot-all.mjs`; uses Playwright Chromium, falls back to `/usr/bin/google-chrome`.) Capture the full "before" set now.

### 1. Tokens

`src/renderer/src/theme.css`

- Text tiers (graphite `:146-149`, paper `:652-655`): `--text` / `--text-secondary` / `--text-muted` move to t1/t2/t3 with contrast ≥4.5:1 on every ground; `--text-faint` is removed from text use (decorative only).

```css
/* graphite */
--text: rgba(255,255,255,.92);            /* 13.9-16.2:1 */
--text-secondary: rgba(255,255,255,.66);  /* 7.8-8.5:1 */
--text-muted: rgba(255,255,255,.52);      /* 5.4-5.7:1 */
/* paper */
--text: #1d1d1f; --text-secondary: #424245; --text-muted: #66666b; /* >=4.8:1 */
```

- Accent split: `--accent` (fill, white ink ≥4.5:1) and `--accent-ink` (links, focus, working).
- Radius (`:1254-1272`, 20 tokens / 13 values) collapses to four roles; existing token names alias to them so feature code is untouched:

```css
--r-badge: 4px; --r-ctl: 6px; --r-group: 10px; --r-dialog: 14px;
--tr-radius-sm: var(--r-ctl); /* ...each legacy name maps to one role */
```

- Icon ladder (`:1518-1533`): 15px glyph at stroke 1.6 beside 13px text; 13px at 1.7 beside 11-12px.
- Type scale: largeTitle 26/32 700 -0.02em, title 20/26 650, headline 13/18 600, body 13/18 400, callout 12/16, caption 11/14 600.
- Font (`:1787`): `--font-sans: 'Inter Variable', system-ui, ...;` plus `font-optical-sizing: auto` on `body`.
- Terminal Auto palette for Paper: ANSI blue/magenta/green/yellow `#0a5cd1/#a3195b/#1d7a3a/#8a5a00` (≥5:1 on white). Regression test in `theme.paletteContrast.test.ts` asserting ≥4.5:1 for prompt and path colours (fails today: 1.64:1 and 1.19:1).

`src/renderer/src/main.tsx:6-9`: replace the four Plus Jakarta imports with `import '@fontsource-variable/inter/opsz.css'`; `ui/package.json:28` swaps the dependency; licence inventory regenerated (`check-third-party-licenses.sh`).

Guards tightened: `check-radius-tokens.sh` (4 values), `check-icon-metrics.sh` (new ladder), `check-type-scale.sh` (new scale).

### 2. One status vocabulary

Today: `PaneStatusDot` (`components/ui/PaneControls.tsx`), `StatusDot` (`components/SessionPane.tsx:184`), `ChildStatusDot` (`components/ChildrenRoster.tsx`), `OrchestratorStatusDot`, `ActivityDot` (`components/ui/ActivityDot.tsx`), the grid rail dot. New primitive replaces all of them:

```tsx
// components/ui/StatusGlyph.tsx
export type StatusGlyphState = 'working' | 'needs' | 'finished' | 'error' | 'idle'
export function StatusGlyph({ state, label }: { state: StatusGlyphState; label?: string }): React.JSX.Element | null
// working: 9px arc spinner (static 270deg arc under reduced motion)
// needs: 8px warn dot with ring; finished: 6px accent-ink dot; error: 11px stop circle with "!"; idle: renders nothing
```

`ui-primitives` specimen case for every state x theme. New guard `check-status-glyph.sh`: no `rounded-full` + status colour outside `StatusGlyph`.

### 3. Primitive recipes

Update in the specimen first, then in place: `Button`/`buttonChrome.ts` (primary fill, ghost), rows (`navRow.tsx`, `SettingsRailRow.tsx`, `WorkspaceTreeRow.tsx`), `Chip`, `Select`, toggle, segmented, menu (`ActionMenu.tsx`), `CommandPalette.tsx`, `Card` (one level only), kbd, `ConnectionBanner.tsx`/`FloatingBanner.tsx`, `EmptyState.tsx`/`ActionEmptyState.tsx`. Hover reveals per-row actions; focus rings `:focus-visible` 2px accent-ink.

### 4. Sidebar

`components/Sidebar.tsx`, `components/ui/GridRailRow.tsx`, `WorkspaceTreeRow.tsx`, `WorkspaceGroupLabel.tsx`: Expanded tree, roll-up on collapsed workspaces (`needs > error > working > finished`), counts right-aligned tabular, grid caption with branch in mono 11px, sessions as rows with mark / title / glyph / age. Remove the selected-grid card. Tests pinned on old geometry (`Sidebar.treeRowHeights`, `Sidebar.selectionFill`, `Sidebar.noContainerLines`) updated to the new values, not deleted.

### 5. Pane header

`components/SessionPane.tsx` header (`:617`, `pane-header-ladder.test.ts`): mark, name 13/600, branch mono 12 t3, `StatusGlyph` + word; actions on hover/focus. Exited state: header word "Exited with code N" and a footer bar with Restart (keeps output).

### 6. Settings

`components/SettingsView.tsx`, `SettingsDetail.tsx`, `settingsSections.ts`: rail header becomes "Settings", back row "Workspaces" + Esc, search with `/`; every page gets a largeTitle; group heading 13/600 t1 above the group, row title 13/500, description 12 t3; bordered selects.

### 7. Pages: Tasks, Routines, PRs, Usage

One `--page-w: 960px` for every page; new guard `check-page-width.sh` rejects per-page `max-width`. Tasks: no provider column on rows without an agent; Routines: list + detail without nested cards, rows open their report, link on hover; PRs/Usage tokens only.

### 8. Empty, first run, offline, narrow

`WorkspaceEmpty.tsx`, `WorkspacesEmpty.tsx`: serif title, launch tiles show only exceptions ("No status: hooks off"). Offline banner in the rail (`ConnectionBanner.tsx`). Rail hidden: titlebar gets show-sidebar and a "N needs you" chip (`AppTitlebar.tsx`).

### 9. Cleanup

Audit the 46 files with `outline-none` (replace with `focus-visible` rings; `check-focus-visible.sh` ratchet); mono-for-prose sweep ("Click to continue", "Select element..."); text glyph "▶ test" becomes the play icon; remove `@fontsource/plus-jakarta-sans`.

### 10. Documentation

`docs/internals/styleguide.md` rewritten in place (no appended second account): Overview & identity (:8), Color roles (:72), Typography (:225), Spacing (:273), Radius (:314), Components (:471), States (:835), Motion (:852), Guards (:962). Glossary: *status glyph*, *roll-up*. `docs/user/`: rail hidden shows the attention chip. Runs `check-doc-hygiene.sh`. (Docs may also land inside each phase commit; this commit closes gaps.)

## Per-commit gate

`cargo` untouched. Renderer: `bun run typecheck`, `bun run test`, guards in `scripts/check-*.sh`, `check:css`, `check:bundle` (bundle grows by the Inter opsz files; update `bundle-budget.json` with the measured delta and a one-line rationale). Capture "after" with `scripts/capture-stories.mjs`; review contact sheets in both themes. Before push: full suites under `scripts/oom-shield.sh`.

## Estimates (guess, not measured)

Agent: 20-60 min per commit, ~6-8 h across 11 commits. Machine: renderer gate ~10-15 min per commit, full suites ~20-30 min once before push (guess; measure on commit 1).
