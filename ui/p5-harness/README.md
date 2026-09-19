# CSS conversion harness

The measuring instrument used while converting hand-written CSS to Tailwind
utilities. It renders the **old** component — the pre-conversion source, with
its deleted CSS rules re-injected exactly where they lived — against the
**new** one, and diffs what actually paints.

Not part of the app build. Nothing here is imported by `src/`.

It **is** typechecked: `bun run typecheck` runs `tsc -p p5-harness` after the
root project. The harness needs `allowImportingTsExtensions` and relaxed
unused-symbol rules `src` must not have, hence its own `tsconfig.json`.

## Why it exists

jsdom implements no CSS, so the `ui/` test gate cannot see a single thing a
conversion changes. Reading computed styles is not enough either — a
confidently wrong verdict is easy to produce from style-reading alone, in both
directions: dead declarations that look live, and identical renderings that
look broken. See `docs/internals/css-conversion-patterns.md` for the full
methodology this harness exists to support.

## Run it

```sh
bunx vite build --config p5-harness/vite.config.mts
(cd p5-harness/dist && python3 -m http.server 8931 &)

node p5-harness/shoot.mjs                    # bitmaps, every case
node p5-harness/styles.mjs                   # computed-style + geometry tree walk
CASE=<case-id> node p5-harness/states.mjs    # forced hover/focus-visible/active
THEME=light node p5-harness/shoot.mjs        # per-theme
MOTION=reduce node p5-harness/shoot.mjs      # per motion preference
```

Everything must report **0**. `shoot.mjs` and `states.mjs` exit non-zero
otherwise.

## Shape

- `main.tsx` — the case list and the fixed stage per surface under
  measurement. `window.__setView(caseId, side)` and `window.__cases` are the
  contract the scripts drive.
- `Old<Component>.tsx` — a snapshot of a component as it was before its
  conversion, imports repointed at `../src/...`, export renamed. Regenerated
  per surface; stale the moment its conversion lands.
- `old-full.css` — the whole pre-conversion stylesheet, injected scoped under
  `:where([data-side='old'])` so each rule keeps exactly the specificity it
  had, then compared against the same rules living in the built app.
- `props.json` — real data, generated from a fixture rather than invented
  markup, for any surface whose rendering depends on state.
- `shoot.mjs` / `states.mjs` / `styles.mjs` — the reusable measurement
  scripts: bitmap diff, forced-pseudo-state diff, and a computed-style +
  geometry tree walk, respectively.

## Retiring this harness

Once no conversion is in flight, an old-vs-new run stops proving a conversion
and only catches regressions against the historical baseline. Keep it until
it stops earning its keep; retiring it is a decision to record, not a default.
