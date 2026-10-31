# Brief: extend the Houston "Native" mock to one surface family

You extend the design reference for Houston, a Linux/Windows desktop app (Tauri + React) for CLI coding
agents. Direction B ("Native") is already chosen and partly mocked. Your job is to mock **every screen,
state, modal, menu and popover of your family** in that same direction, so that the whole app can be
implemented from the mock with nothing missing.

Paths (M = `/tmp/claude-1000/-home-theo-ProjetosPessoais-Houston/828dbba9-fc72-4d93-80ed-aaebc246e156/scratchpad/mocks`):

- Reference mock: `M/houston-mocks.base.html`. Read ALL of it first, CSS included: tokens, recipes
  (`.row`, `.sess`, `.gcap`, `.btn`, `.segc`, `.tog`, `.menu`, `.page`, `.ph1`, `.lt`, `.st.*` status
  glyphs, pane chrome, palette, settings rows), the icon sprite and the script (`go()`, `crumbs`, themes).
- Inventory: `M/inventory.md`. Your family's section lists every harness story you must cover.
- Before captures (current app): `/home/theo/ProjetosPessoais/Houston/.houston/worktrees/design-native/.design-ref/review/0/{graphite,paper}/<story>.png`.
  Open them with the Read tool. `.design-ref/review/9/` and later folders hold newer captures of some stories.
- Source (READ-ONLY): `/home/theo/ProjetosPessoais/Houston/.houston/worktrees/design-native/ui/src/renderer/src`
  and stories in `.../ui/src/renderer/harness`. Read the components so the mock carries the real
  content, controls, copy, states and actions. Also grep your area for dialogs, menus, popovers and
  confirmations that have no story, and mock those too.

## Deliverable

One file only: `M/fragments/<slug>.html` (your slug is in the prompt). Do not edit any other file in
`M/`, any git worktree, or the repository. No git, no builds, no dev servers, no killing processes.

The fragment has up to three parts, each starting with its marker line:

```
<!-- @style -->
/* CSS rules, prefixed with .<slug>- or scoped under [data-view^="<slug>-"]; reuse base tokens and recipes */
<!-- @views -->
<section class="view" data-view="<slug>-<name>" data-group="<Family title>" data-label="<Screen · state>" data-crumb="Houston / Changes" hidden> ... </section>
<!-- @script -->
// optional: scoped interactions only; never redefine base functions
```

- One `section.view` per distinct layout or state. Every story in your inventory section maps to a
  view; record the map at the top of `@views` as an HTML comment: `<!-- map: story -> view -->` lines.
- A view renders the whole window: reuse the base `.app` structure (rail + titlebar + content) when the
  screen lives in the window, copying the rail markup the base uses, so the screen is judged in context.
  A modal, sheet, menu or popover view shows its host screen behind it.
- New icons: add `<symbol id="<slug>-...">` in a hidden `<svg>` inside your first view, drawn like the
  base sprite (24-unit box, stroke 1.6, round caps).
- No new colours. If a role is genuinely missing, add a token for BOTH themes in `@style` under
  `[data-hx="graphite"]` and `[data-hx="paper"]`, with its contrast figure in a comment.

## Design rules (from the base mock and the user)

- Type scale, radius roles (4/6/10/14), 4pt spacing, 28px row and control floor, `--page-w` for pages.
- Inter for UI; Source Serif 4 only for empty and first-run display titles; mono only for machine values
  (branches, paths, hashes, numbers in tables), never for prose or labels.
- Sentence case everywhere. No forced uppercase or tracked labels.
- Status uses the base `.st` glyphs (working, needs, finished, error; idle shows nothing). No new dots.
- Every text tier >= 4.5:1 on its ground in both themes; do not rely on colour alone.
- Removal pass before you finish: for every copy line, icon, divider, badge and metadata field, ask
  whether it earns its place; remove it if not. Agents over-add; the default is less.
- Cover the states that exist: empty, loading, error, long text, narrow width where the surface can
  be narrow, both themes. Fixtures must be states the app can actually produce.
- When a screen's layout is genuinely open (not settled by the base mock's recipes), provide two
  distinct variants as separate views labelled "… · A" and "… · B" and say so in your result. Do not
  make variants for things the base mock already settles.

## Review

Invoke the `apple-design` skill and review your screens through its five lenses (accessibility,
platform conventions for a desktop app, visual craft, interaction, writing). Fix what it finds in the
mock. Then review against the base mock: same recipes, same density, same voice.

## Verify before you submit

```
python3 M/build-mock.py --only <slug> --out M/preview/<slug>.html
node M/shot-views.mjs M/preview/<slug>.html M/preview/<slug> '^<slug>-'
node M/shot-views.mjs M/preview/<slug>.html M/preview/<slug>-narrow '^<slug>-' 760 800   # if narrow applies
```

Open every PNG with the Read tool and fix what looks wrong. Zero page errors.

## Result (pane_submit)

- Views: count, and the list of view ids.
- Story map: every story covered (say which, if any, are intentionally merged into one view and why).
- Surfaces you found with no story, and how you mocked them.
- Variants that need the user's pick, with a one-line difference each.
- apple-design findings: fixed, and any left open with the reason.
- Open questions that need the user's judgment (keep them few).

## Correction (supersedes "A view renders the whole window" above)

The `<!-- @fragments:views -->` marker now sits inside the base `.content` element, after the last base
view. Your `section.view` elements land beside the base views and inherit the base rail and titlebar.
A view contains only the content area: do not copy `.app`, the rail or the titlebar, and do not move
views from `@script`. A modal, sheet or popover view draws its host content plus the overlay inside the
section (a `position: fixed` scrim is fine). A state that changes the rail itself (a rail menu, renaming,
an options panel) may toggle classes on the base rail from `@script` when `go()` enters that view; wrap
`go` once with `const prevGo = go; go = (...a) => { prevGo(...a); /* your toggles */ }` and undo the
toggles when leaving your views.
