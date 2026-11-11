# Upstream redesign port map

Port map for the six stacked upstream redesign PRs (`pingdotgg/t3code`), one Houston slice per PR on
the integration branch `v2-redesign`. Facts are measured against the pinned SHAs below unless a
line says *inferred*. Per-path data is in `slice-<n>.tsv` beside this file; deviations from the
brief are in `implementation-notes.md`.

## 1. Pins

Houston's fork point is upstream `9826dbb9904b2591bfbf60d1317486b59132f56b` (2026-10-28). The commit is not an ancestor of
Houston's `HEAD` (Houston imported the tree as a copy), but the object is present in the repository's object store, so Houston
diffs use `git diff 9826dbb9 HEAD` directly.

| Slice | PR | Diff base | Diff head | Commits |
|---|---|---|---|---|
| 1 primitives + shell | 28839 | `7e565c510d6dfaef2e1fd97bf9d89a97ce9cece7` (real merge-base, see below) | `f2467a90e1a33dd12924f95f9ff423d228cae70e` | 45 |
| 2 composer + timeline | 28840 | `f2467a90e1a33dd12924f95f9ff423d228cae70e` | `df3c346b2ccf5ce870b842e3b208e9df53115cea` | 78 |
| 3 panels + pages | 28841 | `df3c346b2ccf5ce870b842e3b208e9df53115cea` | `767c503255e6d27d67cffcd0f27b09a4a2427c61` | 32 |
| 4 settings + setup | 28842 | `767c503255e6d27d67cffcd0f27b09a4a2427c61` | `34d194a0a673a03f9f299511d6d7b6d0e3f6dc8a` | 54 |
| 5 voice | 28844 | `34d194a0a673a03f9f299511d6d7b6d0e3f6dc8a` | `51a9ef92424dd76c56d1d85ad1f0aad4a21cbd1a` | 1 |
| 6 workspace panes | 28845 | `51a9ef92424dd76c56d1d85ad1f0aad4a21cbd1a` | `40d5e9692929da92402c23d4eb6ca1286e5f2ca2` | 310 |

- **Slice 1 base.** The PR's recorded base `0318eadc3202c64f3da9aad08ea5aa868a2f0d7c` (2026-11-11 12:02 -0800, in `main`) is not an
  ancestor of the slice 1 head. The real merge-base of the head with upstream `main` is
  `7e565c510d6dfaef2e1fd97bf9d89a97ce9cece7` (2026-11-11 09:35 -0800). `main` is 72 commits ahead of that point at
  `0318eadc`; diffing against `0318eadc` would show 825 paths (the stack's changes plus the reverse of
  those 72 commits), against `7e565c51` it shows 603. All numbers use `7e565c51`.
- **Chain.** Each pinned base is an ancestor of the next pinned head (verified with `merge-base --is-ancestor`).
- **Pinned heads are reachable.** All seven SHAs resolve in the clone. PR 28845's current head is now
  `26d4254700e0d700349d88de6fb381c739a3a876` (2026-11-11 21:06 UTC); the pinned `40d5e969` is its ancestor, so slice 6
  is measured at the pin. The other five PR heads equal the pins.
- **Drift.** `9826dbb9..7e565c51` is 1,998 upstream commits and 43,587 changed paths (all products). Houston does not have
  them. `mechanical+drift` and the `drift` note flag stack paths among them.
- **Stack shape (inferred from commit subjects).** Each PR contains its redesign commit plus many fix commits, and a
  large share of the fix commits carry upstream `main` behaviour into the redesigned surface ("adapt main's …",
  "keep main's …"). The diffs therefore include non-visual upstream changes (section 5 lists them).

Upstream clone: a partial clone (`--filter=blob:none`) kept outside this repository and used read-only.

## 2. Method and path mapping

**Path mapping.** Directory layout is identical (`apps/{web,server,desktop}`, `packages/*`, `scripts`, `docs`, `assets`, `patches`).
The differences are:

| Upstream | Houston |
|---|---|
| import scope `@t3tools/*` | `@houston-app/*` (every file; `@t3tools` has zero occurrences in Houston) |
| package `apps/server` = `@t3tools/server` | `@houston-app/cli` (dir unchanged) |
| `oxlint-plugin-t3code/` (rules prefixed `t3code/`) | `oxlint-plugin-houston/` (rules prefixed `houston/`) |
| 15 renamed files (git rename detection ≥ 40 %), e.g. `packages/contracts/src/t3ProjectFile.ts` → `houstonProjectFile.ts`, `packages/shared/src/t3McpToolPresentation.ts` → `houstonMcpToolPresentation.ts`, `apps/web/src/components/chat/modelPickerSearch.ts` → `packages/client-runtime/src/modelSearch.ts`, `packages/shared/src/relaySigning.ts` → `stableStringify.ts` | applied as explicit mappings; none is touched by the stack except as listed in the TSVs |
| `docs/user/voice-input.md` | `docs/user/dictation.md` (inferred from content) |
| `apps/web/src/components/Sidebar.tsx` (+ `sidebar/*`) | deleted in Houston (`cc9524f520 chore(web): remove orphaned component modules`); Houston's sidebar is `apps/web/src/components/grid/GridSidebar.tsx` (*inferred* replacement) |

**Classification.** Per slice, `git diff --name-status --no-renames <base>..<head>` (renames appear as delete + add). A path
is compared with Houston's file at the same mapped path.

- `mechanical`: Houston's blob equals upstream's blob at `9826dbb9` after replacing `@houston-app/` with `@t3tools/`. The
  scope substitution is applied because without it no Houston file is byte-identical. Marked `mechanical+drift` when the
  path also changed in `9826dbb9..7e565c51`.
- `manual`: Houston's normalised content differs from the fork's. `houston_diff_lines_vs_fork` is added+deleted lines of
  that difference (scope-normalised); `stack_diff_lines` is added+deleted in the slice. Note `merge3=` is a textual
  `git merge-file` of (base = upstream slice base, ours = normalised Houston, theirs = upstream slice head): `clean`
  means no textual conflict, which says nothing about visual or semantic correctness; `conflicts:N` is the hunk count. A
  `manual` row with no `merge3=` has no fork version to merge against (the file exists in Houston and was added upstream
  after the fork).
- `houston-missing`: modified or deleted by the stack; Houston has no file at the mapped path. Split in the table by cause:
  deleted/moved since the fork (the TSV note carries the deleting commit) versus never in Houston (upstream added the
  file after the fork). "Where it went" is only a basename search plus the deletion commit (*inferred*).
- `collides`: added by the stack where Houston already has a different file.
- `follows-prior-slice` (class added to the brief's list): modified by this slice but added by an earlier slice, so it
  ports with that slice. The TSV note names the slice.
- Skipped: `apps/mobile/**` (Houston has no mobile product) and `pnpm-lock.yaml` (regenerate, never merge). The stack
  touches no `apps/marketing` path. Skipped counts are in the table.

## 3. Summary

| Slice | PR | Commits | Raw paths | Skipped | new | mechanical | mechanical+drift | manual | houston-missing | collides | follows-prior-slice | Lines + | Lines - |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 28839 | 45 | 603 | 26 | 18 | 39 | 14 | 445 | 60 | 1 | 0 | 15,594 | 7,745 |
| 2 | 28840 | 78 | 182 | 3 | 19 | 8 | 4 | 140 | 6 | 0 | 2 | 15,390 | 5,056 |
| 3 | 28841 | 32 | 131 | 0 | 11 | 13 | 1 | 104 | 0 | 2 | 0 | 9,702 | 5,270 |
| 4 | 28842 | 54 | 213 | 0 | 13 | 10 | 7 | 163 | 20 | 0 | 0 | 12,628 | 7,399 |
| 5 | 28844 | 1 | 13 | 0 | 0 | 0 | 0 | 11 | 2 | 0 | 0 | 441 | 216 |
| 6 | 28845 | 310 | 546 | 14 | 80 | 32 | 11 | 352 | 30 | 6 | 21 | 41,772 | 11,130 |
| **Total** | | 520 | 1688 | 43 | 141 | 102 | 37 | 1215 | 118 | 9 | 23 | 95,527 | 36,816 |

Lines are added/removed over the non-skipped paths. `follows-prior-slice` rows are counted once in their own slice.

Cost of the `manual` class:

| Slice | manual | 3-way clean | 3-way conflicts | no fork version | base deleted upstream | Σ Houston diff (manual) | Σ stack diff (manual) | manual also drifted | houston-missing: deleted/moved since fork | houston-missing: never in Houston |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 445 | 148 | 276 | 20 | 1 | 60,887 | 18,480 | 318 | 45 | 15 |
| 2 | 140 | 57 | 77 | 3 | 3 | 30,042 | 16,206 | 124 | 5 | 1 |
| 3 | 104 | 27 | 70 | 6 | 1 | 19,997 | 12,298 | 72 | 0 | 0 |
| 4 | 163 | 43 | 112 | 7 | 1 | 33,089 | 16,461 | 131 | 18 | 2 |
| 5 | 11 | 0 | 4 | 7 | 0 | 2,056 | 648 | 11 | 0 | 2 |
| 6 | 352 | 95 | 227 | 23 | 7 | 67,547 | 22,649 | 281 | 15 | 15 |

Reading the table: `manual` is the dominant class (1,215 of 1,645 non-skipped paths) because Houston has already
restyled and restructured the same files (`apps/web` differs from the fork by 1,336 modified, 727 added and 91 deleted
files). A `3-way clean` file still needs a visual check; a `conflicts:N` file needs a hand port.

Houston-only importers of changed primitives (regex over `~/components/ui/<name>` imports in `apps/web/src` files with no upstream
counterpart at the fork, 718 files; relative imports from outside `components/ui` are not counted):

| Slice | `components/ui` files touched | Houston-only files importing one |
|---|---|---|
| 1 | 47 | 28 |
| 2 | 2 | 13 |
| 3 | 4 | 12 |
| 4 | 12 | 15 |
| 5 | 0 | 0 |
| 6 | 26 | 22 |

The 28 files overall are listed in section 4.3. Houston has no `houston/` directory under `apps/web/src`; Houston-only web
code lives in `grid/`, `components/grid/`, `components/ui/*` (grid, merge-queue, voice, preview recipes) and similar.

## 4. Cross-cutting findings

### 4.1 Design tokens and global CSS

Houston already has its own token system in `apps/web/src/index.css` (3,100 lines; upstream's file grows from 2,547 lines at the fork and 2,594 at
the slice 1 base to 5,223 after slice 1 and 6,198 at the slice 6 head). Measured token-name sets (`--name:` definitions):

| | names |
|---|---|
| upstream at fork `9826dbb9` | 274 |
| upstream at `7e565c51` | 275 |
| after slice 1 / 2 / 3 / 4 / 5 / 6 | 559 / 559 / 559 / 562 / 562 / 651 |
| Houston at `HEAD` | 406 |
| names both define (upstream head vs Houston) | 238 (243 at fork) |
| Houston-only names | 168 (`--r-*`, `--h-*`, `--motion-*`, `--text-large-title`, …) |
| stack-new names | 392; Houston already defines 11 of them |
| stack-removed names | 16; Houston defines 14 of them |

Conflicts by name, measured:

- **Type scale.** Both define `--text-title`, `--text-body`, `--text-caption` with different values. Houston: title 20/26,
  headline 13/18, body 13/18, callout 12/16, caption 11/14 (plus display, stat, large-title, heading, prose, mono).
  Upstream head: seven roles `--text-{title,control,label,body,meta,caption,micro}` driven by `--type-*` variables that
  step up on phones (title 24, body 15, meta 14, caption 12, micro 11 px). Same class names, different sizes.
- **Radius.** Houston: four roles `--r-badge 4`, `--r-ctl 6`, `--r-group 10`, `--r-dialog 14` (+ canvas, selection, pill).
  Upstream: `--radius-badge 5`, `--radius-row 6`, `--radius-item 7`, `--radius-control`, `--radius-card 12`, `--radius-pane 14`,
  `--radius-composer…`. No shared names.
- **Motion.** Houston's `--motion-*` roles and `houston/no-raw-motion` (warn) have no upstream counterpart.
- **Surfaces.** Upstream slice 1 introduces a `surfaceStyle` setting (6 styles) and ~100 fill/rim/shadow tokens
  (`--raised-*`, `--lit-*`, `--pill-*`, `--card-*`, `--popover-*`, `--chrome-art-*`, `--bp-*`). Houston has none of them.
- **Font.** Both depend on `@fontsource-variable/inter` (`^5.3.0`, unchanged by the stack); Houston also bundles `@fontsource-variable/jetbrains-mono` (`apps/web/package.json:26-27`).
- `apps/web/src/index.css` is `manual` in slices 1, 2, 3, 4, 6 (Houston diff 1,553 lines; stack diffs 3,349 / 213 / 5 / 44 /
  2,377 lines). It is not a mechanical merge in any slice.

Upstream code is written against upstream's tokens (`rounded-md`, `text-sm`, `--radius-*`, `shadow-*` utilities, etc.).
Taking it as-is would mean either importing upstream's token layer next to Houston's or rewriting each use to Houston's roles.

### 4.2 Houston guards that upstream code would trip

Guards read from `vite.config.ts` and `scripts/check-web-style.mjs`; not run on upstream code. Counts below are a regex
over added lines of the stack's `apps/web/src/**/*.ts(x)` files (excluding tests and `components/ui`), so they are
lower-bound indicators, not guard output.

| Guard | Rule | Added occurrences per slice (1 / 2 / 3 / 4 / 5 / 6) |
|---|---|---|
| `check-web-style` `title-tooltip`, lint `houston/no-native-title-tooltip` | no native `title=` | 25 / 6 / 29 / 91 / 0 / 38 |
| `check-web-style` `radius` (expects `rounded-[var(--r-role)]`) | no raw `rounded-*` | 92 / 29 / 37 / 42 / 4 / 89 |
| `check-web-style` `shadow` | shadow tokens | 6 / 1 / 1 / 2 / 0 / 6 |
| `check-web-style` `type-scale` | `text-<token>` only, floor 11 px | `text-xs/sm/base/lg…` 202 / 7 / 13 / 16 / 0 / 10 |
| `houston/no-raw-motion` (warn) | no raw durations, easings, `transition-all` | `duration-N` 13 / 12 / 0 / 2 / 2 / 6; `ease-*` 5 / 7 / 1 / 0 / 1 / 8; `transition-all` 3 / 0 / 0 / 0 / 0 / 1 |
| `check-web-style` `raw-palette` | no hex / palette colours | hex 21 / 0 / 2 / 7 / 0 / 6; palette-N 2 / 0 / 0 / 0 / 0 / 0 |
| `check-web-style` `ellipsis` | `…` not `...` | 1 / 9 / 15 / 8 / 0 / 0 |
| `check-web-style` `spacing` | no hand-typed lengths | arbitrary `[Npx]` 18 / 57 / 13 / 15 / 0 / 29 |
| `check-web-style` `ui-boundary` (baseline 444 entries) | feature `className` carries layout only | not countable by regex; upstream feature components carry visual classes throughout, so every restyled feature file is a new hit (inferred) |

Other guards that would bind a straight copy: `check-web-style` `native-select`, `native-input`, `focus-visible`,
`control-metrics`, `icon-metrics`, `icon-imports`, `copy` (sentence case), `page-width`, `accent-ink`, `accent-utility`,
`label-tracking`, `empty-state-action` (20 rules; baselines in `scripts/web-style-baseline/`, mostly zero or single-digit,
`ui-boundary` 444, `ellipsis` 52, `focus-visible` 37, `type-scale` 21). `AGENTS.md` exempts feature components that follow the
original port from the feature-`className` rule until a slice adapts them; the exemption is the baseline.

Upstream slice 1 adds four lint rules, absent in Houston's plugin: `no-dot-separated-text`, `no-raw-type-classes`
(`text-title … text-micro` roles only), `no-spaced-caps`, `no-styled-raw-controls` (with per-file debt ceilings in
`vite.config.ts`, naming files such as `Sidebar.tsx` that Houston lacks). They overlap Houston's `type-scale`, `copy`/`label-tracking`
and `ui-boundary`. Adopting them means renaming the `t3code/` prefix to `houston/` and registering them in Houston's
`vite.config.ts`.

### 4.3 Primitives restyled or changed

Primitive API changes by slice (props or exports; from the diffs of `apps/web/src/components/ui/*`):

- **Slice 1:** `button` (sizes `icon-sm`, `xs-pill`, `icon-xs-pill` added; `icon-xl` removed; `outline` and `glass` variants removed,
  about 30 new variants such as `floating`, `success-outline`, `card-row`, `panel-row`; new `ContentButton` export), `badge`
  (default variant `default` → `secondary`, new `tone`), `dialog` (+`app`), `tooltip` (`glass` → `popover`, +`thread`),
  `input-group` (+`InputGroupUnit`), `menu` (+`scope`, new `MENU_ITEM_ROW_CLASS` and `MENU_SUB_TRIGGER_ROW_CLASS`), `combobox`
  (+`inset`), `command` (+`size content`), `kbd` (+`size sm`), `number-field` and `textarea` (size `lg` removed), `sheet`
  (variant `inset` removed), `toast` (+`notification`); new `status-dot`, `labeled-section`, `menu-row-text`, `picker-styles`;
  `text` collides with Houston's own `text.tsx`.
- **Slice 2:** none (2 files).
- **Slice 3:** none by the scan (4 files).
- **Slice 4:** `combobox` (variant `default` → `underline`), `dialog` (+`app-panel`), `number-field` (+`NumberFieldUnit`), `standalone-page`
  (`StandalonePage` props change; +`StandalonePageIcon`, `StandaloneCardHeader`, `StandaloneCardNote`).
- **Slice 5:** none.
- **Slice 6:** `input` (+size `settings`), `menu` (variant `scope` removed again; row class exports change), `number-field` (+size
  `compact`); new `focus-return`, `part-presence`.

Houston-only files importing a stack-changed primitive (28): `components/chat/ModelMentionChip.tsx`,
`components/files/ProjectFileTree.tsx`, `components/preview/PreviewAnnotationSpeech.tsx`, and under `components/ui/`:
`add-project-dialog`, `agent-group-card`, `branches-worktrees-dialog`, `composer-model-effort`, `composer-task-status`,
`copy-button`, `diff-review-controls`, `diff-review-tray`, `diff-view-controls`, `phone-sheet-header`,
`preview-confirmation-dialog`, `pull-request-checks-unknown`, `resume-session-dialog`, `sidebar-grids`, `sidebar-row-meta`,
`status-list`, `thread-now-details`, `voice-model-download-progress`, `voice-waveform` and six browser-test files. Importers per
primitive: `button` 12, `tooltip` 6, `input` 4, `menu` 4, `checkbox` 3, `dialog` 3, `text` 3, `toast` 3, `collapsible` 2, `popover` 2,
`refresh-icon` 2, `toggle-group` 2, and one each for `alert`, `badge`, `command`, `empty`, `kbd`, `select`, `separator`, `sheet`,
`sidebar`, `switch`. Of removed options, `Button variant="outline"` is used in two of them
(`branches-worktrees-dialog.tsx`, `preview-confirmation-dialog.tsx`); no Houston-only file uses `variant="glass"`, `size="icon-xl"`
or `Badge variant="default"`.

### 4.4 Collisions and name clashes

- `apps/web/src/components/ui/text.tsx` (slice 1): Houston's `Text` has variants `body, callout, caption, headline, title, display`
  and tones `default … inherit`; upstream's adds its own variant/tone sets (Houston diff 125, stack 64 lines).
- `apps/web/src/motion/{animation,gesture,paneMotion,registry,spring}.ts` (slice 6): Houston already has these files (pane FLIP
  motion, `MOTION_ROLE_MS` registry) and upstream adds different ones at the same paths (Houston diff 52 / 119 / 717 / 125 / 28
  lines against upstream's new files). `AGENTS.md` names Houston's `paneMotion.ts` and `registry.ts` as invariants.
- Slice 3: `components/pullRequest/PullRequestReadinessCard.tsx`, `PullRequestStackGroup.tsx` (Houston-authored files at the
  paths upstream adds).
- Slice 6: `components/chat/ContextWindowMeter.tsx`.
- "Workspace" means a project in Houston (`workspaceKeyOf(environmentId, projectId)`, sidebar *workspaces → grids → threads*)
  and a scrolling strip of columns in upstream's layout. The glossary has to pick one before slice 6.

### 4.5 Earlier Houston redesign plan (`handoff/redesign/`) versus upstream

`plan-design-b.md`, `brief-executor.md`, `papercuts.md` describe the v1 "design B" rollout (`ui/src/renderer/...`, paths that no
longer exist). Where it conflicts with upstream's redesign:

| Plan B | Upstream stack | State in Houston today |
|---|---|---|
| four radius roles `--r-badge/ctl/group/dialog` | `--radius-*` family, per-surface radii | Houston adopted the plan's roles |
| type scale 26/20/13/13/12/11, text tiers t1-t3 | seven `--text-*` roles (title 24, control 13, label 15, body 15, meta 14, caption 12, micro 11) with phone step-up | Houston adopted the plan's scale |
| Inter Variable + `opsz`, JetBrains Mono for machine values | Inter (no `package.json` change in the stack) | Houston ships both fonts |
| accent split (`--accent` fill, `--accent-ink` ink) | single accent plus `surfaceStyle` gloss/rim styles | Houston's `accent-ink` and `accent-utility` guards (inferred: they enforce the split) |
| `StatusGlyph` as the one status vocabulary | `StatusDot` (new in slice 1) | Houston-only status components exist |
| sidebar "Expanded": workspace headers → grids → every session a row | upstream `Sidebar.tsx` restyle | Houston's `GridSidebar` |
| one `--page-w` and a `page-width` guard | per-page layouts, `StandalonePage` | Houston guard exists |
| settings rail header "Settings", search, group headings | slice 4 floating settings shell | differs |
| `check-web-style` guards ratchet | four new lint rules + debt ceilings | both exist, different shape |

The plan was not edited.

## 5. Slices

Every slice section lists: scope and cost, non-visual changes (contracts, server, desktop, shared, client-runtime) with one line
each, dependency changes, token and guard findings, the primitives it changes, and blockers. The per-path tables are the TSVs.

### Slice 1 — primitives and shell (PR 28839, 45 commits, base `7e565c51`)

Scope. 577 non-skipped paths (26 `apps/mobile` skipped): 445 manual, 60 houston-missing, 39 mechanical + 14 mechanical+drift, 18 new,
1 collides. +15,594 / −7,745 lines. Establishes the primitives (`components/ui`, 47 files), the app shell (titlebar, sidebar, palette,
dialogs) and the token layer; every later slice builds on it.

Largest manual rows (Houston diff vs stack diff):

| Path | Houston diff | Stack diff | 3-way |
|---|---|---|---|
| `apps/web/src/index.css` | 1553 | 3349 | conflicts:19 |
| `scripts/build-desktop-artifact.ts` | 4788 | 12 | conflicts:1 |
| `apps/web/src/components/ChatView.tsx` | 1814 | 93 | conflicts:9 |
| `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx` | 1769 | 15 | clean |
| `apps/web/src/components/DiffPanel.tsx` | 1472 | 64 | conflicts:7 |
| `apps/web/src/components/CommandPalette.tsx` | 1300 | 65 | conflicts:3 |
| `apps/web/src/components/chat/ChatComposer.tsx` | 1256 | 16 | conflicts:3 |
| `apps/web/src/components/usage/UsagePage.tsx` | 1216 | 48 | conflicts:3 |

Houston-missing by directory:

- `apps/web/src/components/`: 9
- `apps/web/src/components/chat/`: 8
- `apps/web/src/components/clerk/`: 8
- `assets/nightly/`: 8
- `apps/web/src/components/settings/`: 7
- `apps/web/src/components/cloud/`: 4
- `assets/nightly/app-icon.icon/Assets/`: 3
- `apps/desktop/src/app/`: 1
- `apps/desktop/src/settings/`: 1
- `apps/desktop/src/window/`: 1
- `apps/server/src/cloud/`: 1
- `apps/web/src/`: 1
- `apps/web/src/cloud/`: 1
- `apps/web/src/components/guest/`: 1
- `apps/web/src/components/onboarding/`: 1
- `apps/web/src/components/preview/`: 1
- `apps/web/src/components/ui/`: 1
- `apps/web/src/shortcuts/`: 1
- `assets/nightly/app-icon.icon/`: 1
- `scripts/`: 1

Collisions:

| Path | Houston diff | Stack diff | Note |
|---|---|---|---|
| `apps/web/src/components/ui/text.tsx` | 125 | 64 | - |

Non-visual changes (each is a decision, not a visual port):

- `packages/contracts/src/ipc.ts`: `DesktopBridge` gains optional `setBlackChrome(enabled)` (renderer tells the host the light "black chrome"
  appearance is on) and `setWindowButtonsVisible(visible)` (macOS traffic lights; no-op elsewhere).
- `packages/contracts/src/server.ts`: `ServerConfig.homeDirectory` (optional; the server user's home, where a project-less terminal or file browser works).
- `packages/contracts/src/settings.ts`: removes `glassOpacity` (with `MIN/MAX_GLASS_OPACITY`, `GlassOpacity`) and `persistComposerContextStrip`;
  adds `SURFACE_STYLES` / `SurfaceStyle` and `surfaceStyle` (6 literals, default `gradient-rim`) and `hideWindowControlsWhenSidebarCollapsed`.
  Houston still reads the removed keys (`appInit.tsx:94-96`, `SettingsPanels.tsx:358,408,541,552`, `AppearanceSettingsPanel.tsx:73-77`, `ChatView.tsx:1915`).
- `apps/server/src/ws.ts`: fills `homeDirectory: NodeOS.homedir()` in the config snapshot (Houston diff 928 lines).
- `apps/server/src/cloud/cliAuthHtml.ts`: restyles the T3 Connect completion page; `houston-missing` (Connect removed in `c87244d4c9`).
- `apps/desktop`: `ipc/channels.ts` (two new channels), `ipc/methods/window.ts` (`setWindowButtonsVisible`, `setBlackChrome` handlers),
  `ipc/DesktopIpcHandlers.ts` (registers both), `preload.ts` (exposes both; window-controls inset formula `30 + 67/zoom`), `electron/ElectronTheme.ts`
  (`shouldUseDarkChrome`, `setBlackChrome` + listeners), `window/DesktopWindow.ts` (macOS traffic-light placement helper, chrome-driven title-bar colours,
  default background `#e4e4e4` in light), `resources/dmg/*.svg` (installer art); tests `DesktopLifecycle.test.ts`, `DesktopClientSettings.test.ts`,
  `DesktopWindow.test.ts` are houston-missing. macOS-specific parts have no Linux or Windows equivalent.
- `packages/shared/src/usageLimits.ts` (+test): CLI-proxy account labels become the account email or "`<Driver> account N`"; `themePalettes.ts`: neutral-grey
  recolour of the default and Grove/Ocean/Chat themes; `themePreview.ts` (mechanical).
- `packages/client-runtime/src/state/terminal.ts` (mechanical): terminal attach idle TTL 0 (a closed terminal no longer re-subscribes and respawns a shell);
  `source-control-core/src/shared/threadPullRequests.ts` (mechanical): list builder gains a `limit` parameter.
- `oxlint-plugin-t3code/`: 4 new rules and tests (section 4.2); `vite.config.ts` registers them with per-file debt ceilings (Houston diff 218 lines).
- `scripts/build-desktop-artifact.ts` (Houston diff 4,788 lines): dmg window 660×432; `scripts/export-android-icons.ts` and `assets/*` (12 files): houston-missing.

Dependencies. None: no `package.json` changes; added `apps/web/src` imports reference no package that Houston's manifests lack
(checked over added import lines). `pnpm-lock.yaml` not touched in this slice.

Tokens and guards. `apps/web/src/index.css`: manual, Houston diff 1,553 lines against a stack diff of 3,349 lines; token names 275 → 559 (300 new, 16 removed). See
sections 4.1 and 4.2. In added non-UI lines: 202 `text-xs/sm/…`, 92 `rounded-*`, 25 `title=`, 21 hex colours, 18 arbitrary `[Npx]` values.

Primitives changed: section 4.3 (47 files; 28 Houston-only importers).

Blockers.

- Token layer decision (section 8, item 1) gates the whole slice: with Houston's tokens kept, every one of the 422 manual web rows is a hand port.
- `Sidebar.tsx`, `SidebarStageBackdrop.tsx`, `sidebar/*` are deleted in Houston; the sidebar restyle has no destination file (decision 6).
- Settings schema removals break Houston readers (decision 2).
- 318 manual files also drifted upstream (up to 1,998 commits of changes Houston never took), so a patch carries unrelated hunks.

### Slice 2 — composer and timeline (PR 28840, 78 commits, base `f2467a90`)

Scope. 179 non-skipped paths (3 `apps/mobile` skipped): 140 manual, 6 houston-missing, 8 mechanical + 4 mechanical+drift, 19 new, 2 follows-prior-slice.
+15,390 / −5,056 lines. 79 rows were already touched in slice 1.

| Path | Houston diff | Stack diff | 3-way |
|---|---|---|---|
| `apps/web/src/components/ChatView.tsx` | 1814 | 772 | conflicts:23 |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` | 2323 | 199 | clean |
| `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx` | 1769 | 678 | conflicts:8 |
| `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` | 848 | 1551 | conflicts:1 |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | 745 | 1203 | conflicts:19 |
| `apps/web/src/components/chat/ChatComposer.tsx` | 1256 | 666 | conflicts:23 |
| `apps/web/src/index.css` | 1553 | 213 | conflicts:10 |
| `apps/web/src/components/chat/TimelineUserMessageRow.tsx` | 1049 | 305 | conflicts:18 |

Houston-missing by directory:

- `docs/user/`: 2
- `apps/server/src/guest/`: 1
- `apps/web/src/components/`: 1
- `apps/web/src/components/chat/`: 1
- `apps/web/src/components/guest/`: 1

Non-visual changes:

- `packages/shared/src/wireProjection.ts` (new, 569 lines) and `assistantStreaming.ts` (new, 67 lines): `apps/server/src/orchestration-v2/WireProjection.ts` is deleted
  and `splitBufferedAssistantText` leaves the server's `assistantStreaming.ts`, so the renderer can project turn items itself. Server importers re-pointed to
  `@t3tools/shared/wireProjection` (`EventSink.ts`, `ProjectionStore.ts`, `ProviderEventIngestor.ts`, `ThreadManagementService.ts`, `ThreadStream.ts`, `http.ts`,
  `guest/GuestShareService.ts`; the last is houston-missing). `packages/shared/package.json` adds the `./assistantStreaming` and `./wireProjection` exports.
  Houston's `WireProjection.ts` differs from the fork by 89 lines.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` (+ 2,323-line Houston-diverged test): tracks Codex per-thread context usage and reports `beforeTokenCount` /
  `afterTokenCount` on compaction items.
- `apps/server/src/terminal/Manager.ts` (+ test): parses shell-integration OSC 133/633 "command finished" marks and publishes `lastCommandExitCode` with a terminal activity event.
- `packages/contracts/src/terminal.ts` (`lastCommandExitCode` on the summary), `orchestrationV2.ts` (`failedTestCount` on two schemas), `keybindings.ts` (`chat.citeSelection`).
- `packages/shared/src/keybindings.ts`, `toolOutput.ts` (+ test; derives `failedTestCount`), `usageLimits.ts` (again).
- `packages/client-runtime`: `composerThreadItems.ts` (`#` lists recent threads: `allowEmptyQuery`, `describe`), `connection/presentation.ts` (`retryAt`),
  `operations/commands.ts` and `state/threadCommands.ts` (`reorderQueuedRun`; the `queued-run.reorder` command already exists in Houston's contract at
  `orchestrationV2.ts:3274`), `state/pendingUserInput.ts` (`countPendingUserInputQuestions`), `state/terminalSession.ts` (`TerminalActivityStatus`),
  `state/threadRequests.ts` (file-change approvals list their files from the provider item).

Dependencies. `packages/shared/package.json`: two `exports` entries only. No package additions.

Tokens and guards. `index.css`: 213 stack lines; 2 token names added, 2 removed. Added non-UI lines: 57 arbitrary `[Npx]`, 29 `rounded-*`, 12 `duration-N`, 9 ASCII
ellipses, 7 `ease-*`.

Primitives changed: 2 files (13 Houston-only importers); no API change found.

Blockers. Houston's `ChatView.tsx` (Houston diff 1,814 vs stack 772), `ChatComposer.tsx` (1,256 vs 666), `MessagesTimeline.logic.ts` (745 vs 1,203) and its test (848 vs 1,551) are
rewritten on both sides: hand port. The `WireProjection` move touches the server and shared and is not visual (split 2a, section 7).

### Slice 3 — panels and pages (PR 28841, 32 commits, base `df3c346b`)

Scope. 131 paths: 104 manual, 0 houston-missing, 13 mechanical + 1 mechanical+drift, 11 new, 2 collides. +9,702 / −5,270 lines. 61 rows already touched in slice 1 or 2.

| Path | Houston diff | Stack diff | 3-way |
|---|---|---|---|
| `apps/server/src/vcs/GitVcsDriverCore.test.ts` | 2991 | 65 | conflicts:4 |
| `apps/server/src/vcs/GitVcsDriverCore.ts` | 2000 | 60 | conflicts:5 |
| `apps/web/src/components/DiffPanel.tsx` | 1472 | 445 | conflicts:15 |
| `apps/web/src/index.css` | 1553 | 5 | conflicts:1 |
| `apps/web/src/components/usage/UsagePage.tsx` | 1216 | 277 | conflicts:12 |
| `apps/web/src/components/pullRequest/PullRequestTimelineTab.tsx` | 220 | 1193 | conflicts:16 |
| `apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx` | 310 | 873 | conflicts:13 |
| `apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx` | 341 | 798 | conflicts:16 |

Collisions (Houston-authored files at paths the stack adds):

| Path | Houston diff | Stack diff | Note |
|---|---|---|---|
| `apps/web/src/components/pullRequest/PullRequestReadinessCard.tsx` | 343 | 554 | - |
| `apps/web/src/components/pullRequest/PullRequestStackGroup.tsx` | 264 | 332 | - |

Non-visual changes:

- `packages/contracts/src/git.ts`: `VcsWorkingTreeFileStatus` (`added | modified | deleted | renamed | untracked`) and an optional `status` on working-tree files.
- `apps/server/src/vcs/GitVcsDriverCore.ts` (+ test): parses porcelain v2 records into that status (Houston diff 2,000 / 2,991 lines for source / test).
- `packages/contracts/src/pullRequest.ts`: check `startedAt` / `completedAt`; review-thread `snippet` lines; reviewer `suggestion`; `requestedAt`; per-commit `checks` roll-up;
  `PullRequestReviewRequestEvent` and `reviewRequests`.
- `packages/source-control-github/src/server/{GitHubPullRequestApi,GitHubPullRequestProvider,gitHubPullRequestJson}.ts`, `pullRequestReads.graphql(.ts)`,
  `pullRequestReviews.graphql(.ts)` (+ tests): fetch and decode those fields; `packages/source-control-core/.../PullRequestProvider.ts`: provider interface.
  The `.graphql.ts` files look generated from the `.graphql` sources (inferred): regenerate rather than hand-merge.
- `apps/server/src/pullRequest/PullRequestService.ts`: `getShared` retries a cache read cancelled by its previous reader; passes `reviewRequests` through.
- `packages/shared/src/delimitedPreview.ts` (+ test): column kinds (`number | date | text`) for compact CSV previews.

Dependencies. None.

Tokens and guards. `index.css`: 5 lines. Added non-UI lines: 29 `title=` (13 files), 37 `rounded-*`, 15 ASCII ellipses, 13 arbitrary `[Npx]`, 13 `text-xs/sm`.

Primitives changed: 4 files (12 Houston-only importers); no API change found.

Blockers. Houston's `DiffPanel.tsx` (1,472 vs 445), `UsagePage.tsx` (1,216 vs 277) and `PullRequestTimelineTab.tsx` (220 vs 1,193) are rewritten on both sides. Houston authored its own
`PullRequestReadinessCard.tsx` (343-line diff vs stack's 554) and `PullRequestStackGroup.tsx` (264 vs 332).

### Slice 4 — settings and setup (PR 28842, 54 commits, base `767c5032`)

Scope. 213 paths: 163 manual, 20 houston-missing, 10 mechanical + 7 mechanical+drift, 13 new. +12,628 / −7,399 lines. 135 rows already touched earlier.

| Path | Houston diff | Stack diff | 3-way |
|---|---|---|---|
| `apps/server/src/vcs/GitVcsDriverCore.ts` | 2000 | 2 | clean |
| `apps/web/src/components/ChatView.tsx` | 1814 | 26 | conflicts:3 |
| `apps/web/src/components/GitActionsControl.tsx` | 339 | 1288 | conflicts:17 |
| `apps/web/src/index.css` | 1553 | 44 | conflicts:3 |
| `apps/web/src/components/settings/ScheduledTasksSettings.tsx` | 487 | 984 | conflicts:12 |
| `apps/web/src/components/CommandPalette.tsx` | 1300 | 9 | clean |
| `apps/web/src/components/usage/UsagePage.tsx` | 1216 | 11 | conflicts:3 |
| `apps/web/src/components/settings/SettingsPanels.tsx` | 988 | 210 | conflicts:14 |

Houston-missing by directory:

- `apps/web/src/components/clerk/`: 5
- `apps/web/src/components/cloud/`: 3
- `apps/web/src/cloud/`: 2
- `packages/shared/src/`: 2
- `apps/desktop/src/settings/`: 1
- `apps/server/src/cloud/`: 1
- `apps/web/src/components/`: 1
- `apps/web/src/components/onboarding/`: 1
- `apps/web/src/components/search/`: 1
- `apps/web/src/components/settings/`: 1
- `docs/user/`: 1
- `packages/contracts/src/`: 1

Non-visual changes:

- New streaming RPC `agentSessions.importWithProgress`: `packages/contracts/src/{rpc.ts, agentSessions.ts (AgentSessionImportProgressEvent), clientRpcPermissions.ts, environment.ts (capability
  flag agentSessionImportProgress)}`, `apps/server/src/{auth/RpcAuthorization.ts (operate scope), observability/RpcInstrumentation.ts ("workspace"), environment/ServerEnvironment.ts, ws.ts,
  project/AgentSessionImporter.ts (progress callback, at most every 250 ms)}`, `packages/client-runtime/src/rpc/client.ts`. `AGENTS.md` requires the instrumentation and authorisation entries.
- `apps/server/src/project/AgentSessionScanner.ts` (+ test, Houston diff 930 / 1,119): a partial scan retries with a doubling budget up to 16×.
- `apps/server/src/ws.ts` + `packages/client-runtime/src/state/models.ts`: archived thread shells carry `messageCount` (inline SQL here; slice 6 moves it into the projection store).
- `apps/server/src/vcs/GitVcsDriverCore.ts`: `lastCommitAt` on branch listings.
- `packages/contracts/src/ipc.ts`: confirm dialog gets `title` and `confirmLabel`; `desktop/preload.ts`: window corner geometry variables for macOS 27 (`--desktop-window-corner-radius`).
- T3 Connect (houston-missing): `apps/server/src/cloud/CliTokenManager.ts` (device label, request code, cancel handling), `packages/shared/src/connectAuth.ts` (device and code; Houston has
  it, manual), `relayClient.ts` (+ test), `contracts/src/relayClient.ts`.

Dependencies. None.

Tokens and guards. `index.css`: 44 lines; 3 new names. Added non-UI lines: 91 `title=` (24 files), 42 `rounded-*`, 16 `text-xs/sm`, 15 arbitrary `[Npx]`, 8 ASCII ellipses, 7 hex.

Primitives changed: 12 files (15 Houston-only importers); API changes listed in section 4.3 (`combobox`, `dialog`, `number-field`, `standalone-page`).

Blockers. Houston's `GitActionsControl.tsx` (339 vs 1,288) and `ScheduledTasksSettings.tsx` (487 vs 984) diverge on both sides. 20 rows have no destination (T3 Connect, clerk, cloud, relay).
`ChatView.tsx` (1,814) and `CommandPalette.tsx` (1,300) are touched again with small stack diffs (26 / 9 lines).

### Slice 5 — voice (PR 28844, 1 commit, base `34d194a0`)

Scope. 13 paths, all in `apps/web` plus `vite.config.ts` and `docs/user/voice-input.md`: 11 manual, 2 houston-missing. +441 / −216 lines.

Houston's dictation is its own implementation (`feat(voice): …`, `feat(composer): dictate into the composer with local transcription`): 7 of the 11 manual rows (`ComposerSpeechButton.tsx`,
`VoiceInputSetup.tsx`, `MicrophoneTest.tsx`, `SpeechModelComparison.tsx`, `VoiceSettingsPanel.tsx`, `speech/useEnvironmentSpeechInput.ts`, `speech/useTextFieldSpeech.tsx`)
have no upstream counterpart at the fork, and `VoiceInputErrorPill.tsx` is houston-missing. The upstream files exist at the stack base (voice input landed upstream after the fork) but are different
files from Houston's. The slice is therefore a restyle of Houston's voice UI using the stack as reference, not a patch.

| Path | Houston diff | Stack diff | 3-way |
|---|---|---|---|
| `apps/web/src/components/chat/ChatComposer.tsx` | 1256 | 161 | conflicts:5 |
| `apps/web/src/components/chat/ComposerPrimaryActions.tsx` | 315 | 50 | conflicts:8 |
| `apps/web/src/components/chat/ComposerFooterControls.tsx` | 267 | 6 | conflicts:3 |
| `vite.config.ts` | 218 | 9 | conflicts:1 |

Non-visual changes. None (`apps/web` only). `docs/user/voice-input.md` maps to `docs/user/dictation.md` (inferred).

Dependencies. None. Tokens and guards: no `index.css` change; added non-UI lines: 4 `rounded-*`, 2 `duration-N`, 1 `ease-*`. No `components/ui` file touched.

Blockers. `ChatComposer.tsx` (Houston 1,256 / stack 161, 5 conflict hunks), `ComposerPrimaryActions.tsx` (315 / 50, 8 hunks) and `ComposerFooterControls.tsx` (267 / 6, 3 hunks) depend on slice 2's
composer. Order: slice 2 before slice 5.

### Slice 6 — workspace panes (PR 28845, 310 commits, base `51a9ef92`)

Scope. 532 non-skipped paths (13 `apps/mobile` and 1 `pnpm-lock.yaml` skipped): 352 manual, 30 houston-missing, 32 mechanical + 11 mechanical+drift, 80 new, 6 collides,
21 follows-prior-slice. +41,772 / −11,130 lines. 308 rows were already touched by slices 1 to 5. The PR bundles the layout model with other features (18 `feat` commits: Labs scrolling workspaces,
Classic theme, context-window meter, subagent rows, wake-ups rail, lineage ghost tabs, `mod+l` pull-request toggle).

| Path | Houston diff | Stack diff | 3-way |
|---|---|---|---|
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` | 6203 | 270 | conflicts:1 |
| `apps/web/src/index.css` | 1553 | 2377 | conflicts:15 |
| `apps/server/src/orchestration-v2/Orchestrator.ts` | 2783 | 12 | clean |
| `apps/web/src/components/ChatView.tsx` | 1814 | 818 | conflicts:38 |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | 2113 | 82 | conflicts:2 |
| `apps/web/src/components/RightPanelTabs.tsx` | 628 | 1471 | conflicts:21 |
| `apps/server/src/orchestration-v2/ProjectionStore.test.ts` | 1918 | 120 | clean |
| `apps/web/src/components/chat/MessagesTimeline.browser.test.tsx` | 1769 | 34 | conflicts:1 |

Houston-missing by directory:

- `apps/web/src/components/chat/`: 6
- `apps/web/src/components/`: 5
- `apps/web/src/cloud/`: 2
- `apps/web/src/components/settings/`: 2
- `docs/user/`: 2
- `apps/desktop/src/preview/`: 1
- `apps/desktop/src/window/`: 1
- `apps/server/src/cloud/`: 1
- `apps/server/src/relay/`: 1
- `apps/web/src/components/auth/`: 1
- `apps/web/src/components/cloud/`: 1
- `apps/web/src/components/guest/`: 1
- `apps/web/src/components/sidebar/`: 1
- `apps/web/src/components/ui/`: 1
- `apps/web/src/lib/`: 1
- `apps/web/src/shortcuts/`: 1
- `packages/client-runtime/src/state/`: 1
- `patches/`: 1

Collisions:

| Path | Houston diff | Stack diff | Note |
|---|---|---|---|
| `apps/web/src/components/chat/ContextWindowMeter.tsx` | 216 | 55 | - |
| `apps/web/src/motion/animation.ts` | 52 | 192 | - |
| `apps/web/src/motion/gesture.ts` | 119 | 178 | - |
| `apps/web/src/motion/paneMotion.ts` | 717 | 640 | - |
| `apps/web/src/motion/registry.ts` | 125 | 93 | - |
| `apps/web/src/motion/spring.ts` | 28 | 101 | - |

Non-visual changes:

- `packages/contracts/src/settings.ts`: `LayoutSettings` and its enums (`LayoutPaneKind`, `LayoutTemplate`, terminal/side-pane placement, `LayoutNewTabPosition`, `LayoutWhenNoRoom`),
  `layoutThreeFingerSwipe`, `scrollingWorkspacesEnabled`, and a legacy optional `layout` on the settings schema; panel-animation default 0 → 150 ms. `server.ts`: `ServerConfig.settings`
  carries the legacy `layout` field. `apps/server/src/serverSettings.ts` (+ test): preserves that field on disk and returns it so each client migrates it.
- `packages/contracts/src/keybindings.ts`: 25 `layout.*` commands, `tab.new/next/previous/close`, `pullRequests.toggle`; `rightPanel.new` and `rightPanel.toggleMaximized` retired (still decode).
  `apps/server/src/keybindings.ts` (+ test): drops retired defaults left in the persisted file and rewrites it. `packages/shared/src/{keybindings,keybindingMatching,preview}.ts`.
- `packages/contracts/src/{providerRuntime,orchestrationV2}.ts`: `ContextBreakdown` (`system_prompt … messages`, `t3_tools`, `other`, ≤ 16 entries) on token usage; `ipc.ts`: menu
  `shortcut` / `accelerator`, preview forwarded-chord schemas.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (+ test, testkit): reads the Claude SDK `getContextUsage` categories into the breakdown and splits the
  MCP tools of the server named `t3-code` into `t3_tools` (Houston's MCP server name differs: the literal needs mapping, inferred); `ProjectionStore.ts`
  (`carryProviderTurnContextUsage`, `countArchivedThreadMessages`), `EventSink.ts`, `Orchestrator.ts`, `ThreadManagementService.ts`, `ws.ts` (archive counts move out of inline SQL).
- `apps/desktop`: preview manager forwards layout key chords from a focused preview webview to the app window (`ipc/channels.ts`, `ipc/methods/preview.ts`, `preload.ts`,
  `preview/Manager.ts`), `window/DesktopApplicationMenu.ts` (macOS accelerators), `window/DesktopWindow.ts` (three-finger swipe → `layout-swipe-<dir>` menu action when both layout settings are on),
  `electron/ElectronMenu.ts` (mechanical+drift: menu items show their accelerator, unregistered). `preview/Manager.test.ts` and `window/DesktopWindow.test.ts` are houston-missing.
- `packages/client-runtime/src/state`: `contextWindow.ts` (houston-missing; breakdown), `subagentDisplay.ts` (`subagentGroupSummary` removed), `threadRequests.ts`, `threadVisits.ts`
  (dispatched-visit watermarks survive a layout tab unmount), `threads.ts`, `vcsAction.ts` (mechanical: removes the `VcsActionStep` progress checklist, 52 lines).
- `apps/server/src/cloud/cliAuthHtml.ts` (houston-missing, 126 lines) and `relay/AgentAwarenessRelay.test.ts` (houston-missing).

Dependencies. No `package.json` change. `pnpm-workspace.yaml` (manual): `patchedDependencies` now patch `@legendapp/list@3.7.2` (rewritten patch) and add a patch for
`@pierre/trees@1.0.0-beta.6`. Houston pins `@legendapp/list` 3.3.5 (catalog, patched) and already depends on `@pierre/trees` 1.0.0-beta.6 without a patch; the list patch targets a version Houston
does not use (drift). `patches/@pierre%2Ftrees@1.0.0-beta.6.patch` is new (32 lines); `patches/@legendapp__list@3.7.2.patch` is houston-missing.

Tokens and guards. `index.css`: 2,377 stack lines; names 562 → 651 (95 new, 6 removed). Added non-UI lines: 89 `rounded-*`, 38 `title=` (21 files), 29 arbitrary `[Npx]`, 10 `text-xs/sm`, 8 `ease-*`,
6 hex, 6 `duration-N`, 1 `transition-all`. Houston's `motion/` files collide with upstream's new ones (section 4.4); upstream's colliding files are named like a spring/registry layer (inferred from the names), so
`houston/no-raw-motion` and the compositor-only rule in `AGENTS.md` (transform and opacity only) need to be checked against the new `layout/` animations (`workspaceSwitch`, pane transitions;
not measured).

Primitives changed: section 4.3 (26 files; 22 Houston-only importers).

Layout model: section 6.

Blockers.

- The layout model (section 6): 28 renderer files outside `grid/`/`components/grid/` consume Houston's grid; 68 upstream files consume the layout store; the sidebar lives in a different file.
- `ChatView.tsx` (Houston 1,814 / stack 818), `RightPanelTabs.tsx` (628 / 1,471), `ClaudeAdapterV2.ts` (2,113 / 82) and its test (6,203 / 270), `Orchestrator.ts` (2,783 / 12).
- Houston `motion/` collisions; the `t3-code` MCP server name; scrolling workspaces are Labs (default off) upstream, so a Houston default needs a decision.


## 6. Slice 6 layout model

### 6.1 The two models

Upstream (`apps/web/src/layout/`, 34 files reference the layout modules inside the directory; 45 are new files in slice 6).

- Shape (`layoutModel.ts`): `LayoutState { workspaces[], focusedWorkspaceId }` → `LayoutWorkspace { id, name|null, columns[], focusedPaneId,
  cameraWidth|null }` → `LayoutColumn { id, panes[], width }` (width is a share of the strip; presets 1/3, 1/2, 2/3, 1; minimum 0.2) →
  `LayoutPane { id, tabs[], activeTabId, size }` (share of column height, minimum 0.1) → `LayoutTab { id, content, ghostOf? }`.
- Tab content: `chat` (a `ThreadRouteTarget`, thread or draft), `settings | usage | pull-requests` pages, `launcher`, or `surface`
  (diff, files, file, browser, terminal, pull request, device of a thread, keyed by `ScopedThreadRef` + `surfaceId`). A tab key
  makes a thing unique per layout.
- Scope: global, not per project; tabs carry environment + thread refs.
- Persistence (`layoutStore.ts`): zustand `persist` to `localStorage` key `t3code:layout-state:v2`, version 3, deferred
  storage, `saveLayoutNow()`. No server copy. Upstream moves the *layout settings* (template, placements, `whenNoRoom`) from
  server settings to a read-only legacy `layout` field that each client migrates (`serverSettings.ts`, `contracts/settings.ts`
  `LayoutSettings`).
- Multiple workspaces are gated by the client setting `scrollingWorkspacesEnabled` (Labs, default false); `layoutThreeFingerSwipe`
  (macOS) moves between columns/workspaces. New keybinding commands: 25 `layout.*`, `tab.*`, `pullRequests.toggle`.

Houston (server-owned grids).

- Contract `packages/contracts/src/houston/grids.ts` (211 lines): `HoustonGridRecord { id, environmentId, projectId (mandatory),
  workspaceKey, name, tree | null, pinnedAt | null, hidden, createdAt, revision, updatedAt }`. `tree` is a nested split tree
  (`HoustonGridLayoutNode = thread leaf | split { dir: row|col, children, weights }`), depth ≤ 8, at most **6** thread leaves,
  one leaf per thread. Leaves carry `threadId`, `id` and an optional `draftId`; there are no tabs and no non-thread panes.
  `HOUSTON_GRID_LIMITS`: name 120 chars, 6 threads, depth 8, 200 grids per project.
- Errors `invalid | limit | not_found | grid_full | cross_project`; `cross_project` refuses placing a thread of another project
  (`apps/server/src/houston/grids.ts:215`).
- Table `houston_grids (id, project_id, record_json, revision, created_at, updated_at)` + index
  `idx_houston_grids_project`, migration id 18 `Grids` on the Houston track (`apps/server/src/houston/migrations.ts:805`, table
  definition `:21-30`).
- Service `HoustonGridService` (`apps/server/src/houston/grids.ts`, 621 lines): list/get/create/put (optimistic
  `expectedRevision`, `conflict` result)/rename/setHidden/setPinned/placeThread/removeThread/delete/sweepOrphans/subscribe;
  mutations run in a transaction under a lock and publish a stream event.
- Shared domain `packages/shared/src/grid/{record,tree}.ts` (349 + 620 lines): pure tree operations, presets, MAX 6.
- Renderer keeps focus and open panels locally; the store also persists the grid list in `localStorage` (`houston:grids:v1`,
  `apps/web/src/grid/gridStore.ts:165`) and merges server records (`gridServerMerge.ts`, `gridSync.ts`).

### 6.2 Consumers of the grid contract and service

Server (non-test): `apps/server/src/houston/grids.ts`, `houston/migrations.ts`, `houston/gridToolkit/{handlers,placement,tools}.ts`,
`ws.ts:226,1570,3385-3388` (RPC handlers), `server.ts:137,626` (layer + startup sweep), `auth/RpcAuthorization.ts:218-221` (read/operate scopes),
`observability/RpcInstrumentation.ts:245-248`, `mcp/McpHttpServer.ts:46-47` (registers `GridToolkit`),
`mcp/toolkits/orchestrator/{handlers.ts:7,173,186; tools.ts:45,60}` (launch `grid` target, `gridId` in thread reads),
`mcp/toolkits/project/{handlers.ts:1; tools.ts:24,43,160-179}` (launch placement).
Contracts: `packages/contracts/src/houston/grids.ts`, `rpc.ts:661-664,2103-2126,2944-2947` (`houston.grids.{list,put,delete,subscribe}`),
`orchestratorMcp.ts:28,278,304`, `package.json` (export). Shared: `packages/shared/src/grid/*`, `houstonMcpToolPresentation.ts:356-360`
(tool labels). Client runtime: `packages/client-runtime/src/state/grids.ts`, `rpc/client.ts:75`. Docs: `docs/user/threads-and-grids.md`.
MCP tools: `houston_grid_list`, `_create`, `_update`, `_delete`, `_place_thread`, `_remove_thread` (`gridToolkit/tools.ts:45-111`).
Tests referencing the grid contract or service: 29 files (server `houston/grids.test.ts`, `grids.ws.test.ts`, `gridToolkit/*`, `migrations.test.ts`,
`ws.test.ts`, MCP and orchestration tests, `peer/*`; `packages/contracts/src/houston/grids.test.ts`; `client-runtime/state/grids.test.ts`;
`apps/web/src/grid/gridServerMerge.test.ts`, `gridSync.test.ts`).

Renderer: `apps/web/src/grid/` (37 non-test files, 31 test files), `apps/web/src/components/grid/` (30 non-test files; holds the
current sidebar `GridSidebar.tsx`, `GridHost.tsx`, `GridThreadCell.tsx`, `GridTerminalDock.tsx`, `GridLayoutMenu.tsx`,
`GridShelves.tsx`, `ProjectFilterPicker.tsx`), route `routes/_chat.grid.$gridId.tsx`. Files outside those directories that import
`~/grid/*` or `components/grid/*` (28): `components/chat/{ChatComposer,ChatHeader,ComposerApprovalCard,DraftProjectContext,ThreadRelationshipsControl,useThreadLifecycle}.tsx`,
`components/{ChatView,CommandPaletteThreadItems,CommandPalette,ThreadNotificationCoordinator,ThreadRouteView,ThreadStatusIndicators}.tsx`,
`components/quickComposer/quickComposer.logic.ts`, `components/sidebar/SidebarChrome.tsx`, `components/tasks/{TaskDetailPanel,TasksPage}.tsx`,
`components/ui/{grid-drop-indicator,resume-session-dialog,thread-drag-overlay}.tsx`, `hooks/{useHandleNewThread,useNewProject,useThreadActionMenu,useThreadRouteTarget}.ts`,
`mobile/PhoneHome.tsx`, `routes/{_chat.grid.$gridId,_chat.index,quick-composer}.tsx`, `shortcuts/chatRouteCommands.ts`. 38 non-test files in
`apps/web/src` reference the grid store (`gridStore`/`useGridStore`).

### 6.3 Upstream files that read or write the layout store

68 files outside `apps/web/src/layout/` reference the layout modules at the pinned head (regex over
`useLayoutStore`, `layoutStore`, `layoutActions`, `layoutModel`, `selectFocusedWorkspace`, `layout/` imports); 34 more are inside
`layout/`. R/W is a regex heuristic (`useLayoutStore.getState/setState`, `layoutActions`, open/close/move/apply calls): 24 W, 44 R.
Every one of the 68 is also changed by the stack, so each is a slice 6 row (class per slice shown).

| Path | R/W (heuristic) | Class per slice |
|---|---|---|
| `apps/web/src/components/AppSidebarLayout.tsx` | W | s1:manual;s2:manual;s4:manual;s6:manual |
| `apps/web/src/components/chat/ChatComposer.tsx` | R | s1:manual;s2:manual;s5:manual;s6:manual |
| `apps/web/src/components/chat/ChatHeader.browser.test.tsx` | W | s6:manual |
| `apps/web/src/components/chat/ChatHeader.tsx` | W | s1:manual;s6:manual |
| `apps/web/src/components/chat/ChatPaneHeader.tsx` | R | s6:new |
| `apps/web/src/components/chat/ComposerApprovalPanel.tsx` | R | s2:new;s6:follows-prior-slice |
| `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` | R | s1:manual;s2:manual;s6:manual |
| `apps/web/src/components/chat/ComposerRequestCard.tsx` | R | s2:new;s6:follows-prior-slice |
| `apps/web/src/components/chat/ComposerStashMenu.tsx` | R | s1:manual;s2:manual;s6:manual |
| `apps/web/src/components/chat/MessagesTimeline.tsx` | R | s1:manual;s2:manual;s4:manual;s6:manual |
| `apps/web/src/components/chat/OpenInPickerShortcut.ts` | R | s6:manual |
| `apps/web/src/components/chat/OpenInPicker.tsx` | R | s1:manual;s2:manual;s4:manual;s6:manual |
| `apps/web/src/components/chat/ThreadRelationshipsControl.tsx` | R | s1:manual;s4:manual;s6:manual |
| `apps/web/src/components/chat/ThreadVisitWatermark.browser.test.tsx` | W | s6:manual |
| `apps/web/src/components/chat/ThreadVisitWatermark.tsx` | R | s6:manual |
| `apps/web/src/components/chat/useChatShortcuts.ts` | R | s6:manual |
| `apps/web/src/components/chat/useChatTerminalActions.ts` | R | s6:manual |
| `apps/web/src/components/chat/useComposerStash.ts` | R | s2:manual;s6:manual |
| `apps/web/src/components/chat/usePasteToFocusComposer.ts` | R | s6:manual |
| `apps/web/src/components/chat/useRightPanelActions.ts` | W | s1:manual;s6:manual |
| `apps/web/src/components/chat/useThreadFindPositionReader.ts` | R | s2:manual;s6:manual |
| `apps/web/src/components/chat/useThreadLifecycle.browser.test.tsx` | R | s6:manual |
| `apps/web/src/components/chat/useThreadLifecycle.tsx` | R | s2:manual;s6:manual |
| `apps/web/src/components/ChatView.tsx` | R | s1:manual;s2:manual;s4:manual;s6:manual |
| `apps/web/src/components/CommandPalette.tsx` | R | s1:manual;s4:manual;s6:manual |
| `apps/web/src/components/ConfirmDialogHost.tsx` | R | s1:mechanical+drift;s4:mechanical+drift;s6:mechanical+drift |
| `apps/web/src/components/device/DevicePanel.tsx` | R | s1:manual;s3:manual;s6:manual |
| `apps/web/src/components/PaneNotch.tsx` | R | s1:new;s6:follows-prior-slice |
| `apps/web/src/components/preview/PreviewPanelShell.tsx` | R | s6:manual |
| `apps/web/src/components/preview/PreviewView.browser.test.tsx` | W | s6:manual |
| `apps/web/src/components/preview/PreviewView.tsx` | R | s1:manual;s3:manual;s6:manual |
| `apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx` | R | s1:manual;s3:manual;s6:manual |
| `apps/web/src/components/pullRequest/PullRequestsColumn.tsx` | R | s1:manual;s3:manual;s6:manual |
| `apps/web/src/components/pullRequest/PullRequestsPage.tsx` | R | s1:manual;s3:manual;s4:manual;s6:manual |
| `apps/web/src/components/RightPanelTabs.tsx` | R | s1:manual;s6:manual |
| `apps/web/src/components/settings/KeybindingsSettings.tsx` | R | s1:manual;s4:manual;s6:manual |
| `apps/web/src/components/settings/LayoutEditor.tsx` | R | s6:new |
| `apps/web/src/components/settings/LayoutSettings.tsx` | W | s6:new |
| `apps/web/src/components/settings/PanelAnimationsPreview.tsx` | R | s1:houston-missing;s6:houston-missing |
| `apps/web/src/components/settings/ProjectSettingsPanel.tsx` | W | s1:manual;s4:manual;s6:manual |
| `apps/web/src/components/settings/settingsLayout.tsx` | R | s1:manual;s4:manual;s6:manual |
| `apps/web/src/components/settings/SettingsScopeNotice.tsx` | R | s1:manual;s6:manual |
| `apps/web/src/components/settings/settingsSearch.ts` | R | s1:manual;s4:manual;s6:manual |
| `apps/web/src/components/settings/SettingsTabNotch.tsx` | W | s6:new |
| `apps/web/src/components/settings/ThemeWireframe.tsx` | R | s1:manual;s6:manual |
| `apps/web/src/components/sidebar/SidebarChrome.tsx` | R | s1:manual;s6:manual |
| `apps/web/src/components/Sidebar.tsx` | W | s1:houston-missing;s4:houston-missing;s6:houston-missing |
| `apps/web/src/components/SurfaceTabIcon.tsx` | R | s6:new |
| `apps/web/src/components/ThreadNotificationCoordinator.tsx` | W | s6:manual |
| `apps/web/src/components/ThreadRouteView.tsx` | W | s6:manual |
| `apps/web/src/components/ThreadSurfaceTab.tsx` | R | s6:new |
| `apps/web/src/components/ThreadTerminalDrawer.tsx` | R | s1:manual;s2:manual;s3:manual;s6:manual |
| `apps/web/src/composerDraftStore.test.ts` | W | s6:manual |
| `apps/web/src/composerDraftStore.ts` | W | s6:manual |
| `apps/web/src/hooks/useHandleNewThread.ts` | W | s6:manual |
| `apps/web/src/hooks/useRemoveClonedProject.ts` | W | s6:mechanical |
| `apps/web/src/hooks/useThreadActions.ts` | W | s4:manual;s6:manual |
| `apps/web/src/lib/workspaceFocus.browser.test.ts` | W | s6:manual |
| `apps/web/src/lib/workspaceFocus.ts` | W | s6:manual |
| `apps/web/src/motion/workspaceSwitch.ts` | W | s6:new |
| `apps/web/src/reopenClosedView.test.ts` | W | s6:manual |
| `apps/web/src/reopenClosedView.ts` | W | s6:manual |
| `apps/web/src/routes/_chat.settings.providers.tsx` | R | s1:mechanical;s4:mechanical;s6:mechanical |
| `apps/web/src/routes/_chat.settings.scheduled-tasks.tsx` | R | s6:mechanical |
| `apps/web/src/routes/_chat.settings.tsx` | R | s1:manual;s4:manual;s6:manual |
| `apps/web/src/routes/__root.tsx` | R | s1:manual;s2:manual;s4:manual;s6:manual |
| `apps/web/src/shortcuts/chatRouteCommands.browser.test.ts` | W | s6:mechanical |
| `apps/web/src/shortcuts/chatRouteCommands.ts` | W | s1:manual;s6:manual |

### 6.4 Which Houston trees convert to columns of panes

Conversion target: a workspace is an ordered list of columns, each a vertical stack of panes; a pane is a tab list. A Houston tree
converts **exactly** when it is: a single leaf (1 column, 1 pane); a root `row` of leaves (n columns of 1 pane); a root `col` of
leaves (1 column of n panes); or a root `row` whose children are leaves or `col` splits of leaves (columns of stacked panes). Weights map to
`width` (normalised to the strip) and `size`. These shapes need no information loss.

Shapes Houston can store today (from `shared/grid/tree.ts` presets, `tidy`, `insertBeside`, schema depth 8) that do **not** convert exactly:

| Shape | Source in Houston | Why it does not convert |
|---|---|---|
| `col(row(a,b), row(c,d))` (4 threads, the preset) | `gridPreset(4)`, `tidy` "grid" | rows come first; columns-of-panes has no row-first nesting. Transposing gives columns `[a,c]`, `[b,d]` and loses per-row split weights and reading order |
| `col(row(a,b,c), row(d,e,f))` (6 threads, the preset) | `gridPreset(6)` | same; transposable to 3 columns of 2 only when both rows share weights |
| `row(a, col(row(b,c), row(d,e)))` (5 threads, the preset) | `gridPreset(5)` | a `row` nested two levels below a `row` through a `col`; columns cannot hold side-by-side panes |
| `col` rows with unequal arity, e.g. `col(row(a,b), c)` | `insertBeside` on a cell of a root `col` | no column alignment exists |
| any alternation `row > col > row` (depth ≥ 3) | drag-drop `insertBeside`, `moveThread`, schema allows depth 8 | upstream has exactly two nesting levels (column, pane); upstream's `span: "full"` template pane is a single special case, not general |
| leaf with `draftId` and no thread | `ThreadNode.draftId` | convertible only as a `chat` tab on a draft target (inferred) |

Equal-weight shapes of the first group are the common ones (presets are generated, *inferred*); the share of stored grids in
each shape is unknown because no user database was read (`~/.houston` is off limits). Measuring it needs a read-only count over a test
fixture or an exported `record_json` set provided by the maintainer.

Other differences the migration must decide: Houston has no tabs (each leaf is one pane with one tab); upstream panes also hold
non-thread surfaces that Houston's tree cannot express, so the conversion is one-way; Houston's `pinnedAt` and `hidden` and `revision`
have no upstream field; Houston's cap of 6 threads and `cross_project` refusal have no upstream counterpart; `workspaceKey` binds a grid to
(environment, project).

### 6.5 Decided direction, expanded into work items (inferred scoping)

1. Contract: `HoustonWorkspaceRecord` adopting `workspace → columns → panes → tabs`, no `projectId`; keep `revision` and optimistic `put`;
   RPC `houston.workspaces.*` next to the existing `houston.grids.*` (`WS_METHODS` in `rpc.ts:661`, `RpcInstrumentation.ts`, `RpcAuthorization.ts`).
2. Migration on the Houston track: next free id after 18 (not measured here: ids are in `apps/server/src/houston/migrations.ts`); new table (or
   reuse `houston_grids` with a version column), conversion of each `houston_grids.record_json` per section 6.4 with the lossy shapes decided.
3. Service: `HoustonWorkspaceService` replaces `HoustonGridService`; remove `cross_project` and the 6 cap, or keep the cap as a named
   limit; keep `sweepOrphans` semantic changes (orphan means a thread leaf whose thread is gone).
4. MCP: `houston_workspace_*` tools; keep `houston_grid_*` as aliases (tool names in `gridToolkit/tools.ts`, labels in
   `houstonMcpToolPresentation.ts:356-360`, launch `grid` target in `orchestratorMcp.ts`/`project/tools.ts`, `gridId` in thread reads).
5. Renderer: upstream's `layoutModel`/`layoutStore` become projections of the server record (the store stops using `localStorage` as source of truth);
   `components/grid/*` and `grid/*` are replaced or adapted (about 67 non-test files plus 28 outside importers).
6. Upstream's layout settings migration (`serverSettings.ts` legacy `layout`) must be reconciled with Houston's server settings
   (Houston has no `layout` field today: verified by grep over `packages/contracts/src/settings.ts`).

## 7. Recommendation on further splits

| Slice | Split? | Proposed cut | Evidence |
|---|---|---|---|
| 1 | Yes, three | **1a** tokens/CSS decision + 47 `components/ui` files + 4 lint rules and baselines; **1b** non-visual: desktop bridge/ElectronTheme/DesktopWindow, `ServerConfig.homeDirectory`, settings schema (`surfaceStyle`, removals), shared themes/usage; **1c** feature-component restyles (about 375 manual web files) | 577 paths, 445 manual, 60 houston-missing; 1a decides everything after it; 1b is the only part touching contracts, server and desktop |
| 2 | Yes, two | **2a** non-visual: `WireProjection` move to `packages/shared`, Codex compaction counts, terminal exit-code (OSC 133/633) activity, `reorderQueuedRun`, approval file lists; **2b** composer + timeline UI | 21 server, 10 client-runtime, 3 contracts and 8 shared rows alongside 132 web rows |
| 3 | Yes, two | **3a** git/PR server and contracts (GraphQL review requests, snippets, per-commit checks, working-tree file status; 9 `source-control-github` + 3 server rows); **3b** panels UI | `GitVcsDriverCore.ts` and its test carry 2,000 and 2,991 Houston diff lines; 17 non-visual rows against 113 web rows |
| 4 | Yes, two | **4a** server/contracts: `agentSessions.importWithProgress` stream, scanner budget, archive message counts, retired settings; **4b** settings/setup UI | one new RPC with `RpcAuthorization` and `RpcInstrumentation` entries (`AGENTS.md` contracts invariant) |
| 5 | No | single PR | 13 files, all web; 7 of 11 manual rows are Houston's own dictation files with no fork counterpart |
| 6 | Yes, four | **6a** non-visual independent of layout: Claude context breakdown, archived-thread message counts, retired keybindings, desktop preview shortcut forwarding; **6b** workspace record, migration, service, tools (section 6.5) before any renderer change; **6c** renderer layout model, panes, tabs, overview, onboarding (`layout/`, 45 files); **6d** the unrelated features riding in the 310 commits (Classic theme, context-window meter, subagent rows, wake-ups rail, lineage ghost tabs) | 310 commits, 546 paths, 18 `feat` commits across unrelated features |

## 8. Open decisions for the maintainer (ordered)

1. **Token layer.** Port upstream's visuals by importing its token layer (surface styles, 15 px type scale, `--radius-*`) next to
   Houston's, or keep Houston's tokens and re-express each upstream component change against them? The two scales share class names with
   different values (section 4.1). Recommendation (inferred): keep Houston's tokens, treat upstream's `index.css` as a reference.
2. **Settings schema.** Slice 1 removes `glassOpacity` and `persistComposerContextStrip` (Houston reads them in `appInit.tsx`,
   `SettingsPanels.tsx`, `AppearanceSettingsPanel.tsx`, `ChatView.tsx`) and adds `surfaceStyle` and
   `hideWindowControlsWhenSidebarCollapsed`. Which of these exist in Houston after the port; do persisted values need a migration?
3. **Workspace vocabulary.** "Workspace" is a project in Houston and a layout strip upstream; pick names for the glossary (section 4.4).
4. **Layout record shape and migration** (section 6): tab content kinds the server stores, fate of `pinnedAt`/`hidden`, the 6-thread cap,
   `cross_project`, the one-way and lossy conversions of section 6.4, alias lifetime for `houston_grid_*` and `houston.grids.*`.
5. **Non-visual upstream changes carried by the stack** (section 5 lists them per slice): take with the slice, take as their own PRs
   (recommended in section 7), or drop.
6. **Sidebar.** The stack restyles upstream's `Sidebar.tsx`, which Houston deleted; restyle `GridSidebar` from the stack's intent, or skip?
7. **Houston's `motion/` files** collide with upstream's new files of the same names (section 4.4); which side keeps the names?
8. **Lint rules.** Adopt the four upstream rules under the `houston/` prefix, or map them to the existing `check-web-style` guards?
9. **Desktop (Electron).** macOS-only changes (traffic-light placement, black chrome, `layoutThreeFingerSwipe`, dmg art, window corner geometry):
   port, or name a Linux and Windows limitation per `AGENTS.md`?
10. **Voice.** Houston's dictation is its own implementation; port the stack's visual changes onto it, or skip slice 5?
11. **Drift.** 318 of slice 1's manual files also changed upstream between the fork and the stack base; take drift where a patch carries it, or
    never?
12. **Pin policy.** Slice 6 is pinned at `40d5e969`; the PR head has moved to `26d42547`. Repin before slice 6 starts, or stay?
13. **Stale plan.** `handoff/redesign/` describes the v1 renderer; archive it before the stack port starts.
