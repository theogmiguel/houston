# Renderer style guard

`scripts/check-web-style.mjs` scans `apps/web/src` for the renderer's design-system rules and
pins what already violates them, so a change may lower the count but never raise it.
`scripts/check-web-style.sh` is the wrapper CI calls.

```sh
bash scripts/check-web-style.sh              # check every rule against its baseline
bash scripts/check-web-style.sh --all        # check and print every failure, not just the first
bash scripts/check-web-style.sh --list       # list the rules
bash scripts/check-web-style.sh --print raw-palette accent-ink
bash scripts/check-web-style.sh --update     # lower every pin to today's count
bash scripts/check-web-style.sh --update title-tooltip
bash scripts/check-web-style.sh --self-test  # prove each rule fires on its bad fixture
```

A normal run exits non-zero when a file gains a violation, when a baseline entry is stale
(the count fell but `--update` was not run), or when a file with no baseline entry starts
violating. A rule whose baseline file is missing also fails.

## How a rule works

A rule is an entry in `RULES` in `scripts/check-web-style.mjs`:

- `id` names the rule and its files: `scripts/web-style-baseline/<id>.baseline` and
  `scripts/web-style-fixtures/<id>/{bad,good}`.
- `decision` is `PORT` for a rule inherited from the upstream renderer or `ADAPT` for a
  Houston-specific rule.
- `exts` limits the rule to source extensions. Test files are always skipped.
- `expected` is the message printed on failure; it states the policy, not the history.
- `scan(ctx)` returns `{ file, line, value }` hits for one file. A rule that needs a broader
  scope filters on `ctx.rel` itself, as `page-width` and `raw-palette` do.

The baseline stores one count per file, sorted by path. The check compares counts per file,
not the total, so moving a violation between files still needs `--update`.

## Lowering the ratchet

Fix the violation first, then tighten the pin:

1. Run `bash scripts/check-web-style.sh` to see which rule and file fail.
2. Fix the code. Do not raise a pin to silence a new violation.
3. Run `bash scripts/check-web-style.sh --update <rule>` to rewrite that baseline with the
   current counts. Running `--update` without a rule rewrites every baseline; use it when a
   change genuinely affects several rules.
4. Check the diff: a baseline should only lose lines. A new line means the fix added a
   violation elsewhere.
5. Run `bash scripts/check-web-style.sh --self-test` and the full check again.

`--update` only records what the scanner finds; it cannot tell a genuine fix from a
false positive. If a hit is a false positive, fix the scanner and add a unit test beside
`scripts/check-upstream.test.mjs` rather than pinning it.

## Current token policy

The rules encode the renderer's colour and metric policy. The terms live in the code,
not in the retired v1 style guide:

- **Colour roles, not palette shades.** Status work uses `--ok`, `--warn`, `--stop` and
  `--info` with their `-ink` or `-foreground` text roles. The `raw-palette` rule rejects
  `text-red-600`, `bg-zinc-900` and the other raw Tailwind palette utilities inside
  `apps/web/src/components`. `apps/web/src/projectIconColors.ts` is intentionally outside
  that directory: it is the palette source for project icons.
- **Hover is neutral.** The Tailwind `accent` utility names were retired: use `bg-hover` and
  `text-hover-foreground`. The `accent-utility` rule rejects `bg-accent` and
  `text-accent-foreground`.
- **Brand colour is a fill.** `--primary` and `--accent` are fills. Brand text and icons use
  `text-(--accent-ink)`; `text-primary` and `text-(--accent)` lack contrast, especially in the
  light theme. The `accent-ink` rule rejects those two utilities. `bg-primary` and
  `text-primary-foreground` remain correct on a primary fill.
- **Control metrics are tokens.** Interactive heights come from `--h-ctl`, `--h-row`,
  `--h-pill` and `--h-pane-head`; `control-metrics` rejects a hand-typed height on a
  button, input, select, textarea or link.
- **Page columns are named.** `WorkspacePageContainer` owns the column through its
  `readable`, `wide` and `expanded` widths. There is no `--page-w` token; `page-width` rejects
  a per-page pixel width.
- **Spacing uses the scale.** `spacing` rejects hand-typed padding, margin and gap lengths;
  there is no `--space-*` escape hatch.

## Attribute detection

`hasAttr` decides whether a JSX tag carries an attribute such as `title`. It first replaces
every `{…}` expression body with spaces, keeping quoted strings inside the expression intact.
Without that step, code in an event handler (`const title = …`) looks like an attribute and
`title-tooltip` pins a false positive. `scripts/check-web-style.test.mjs` covers the literal,
expression, prefix and handler cases.

## Adding a rule

1. Add the rule to `RULES` with a policy-shaped `expected` message.
2. Add `scripts/web-style-fixtures/<id>/bad` and `.../good` fixtures that the rule does and
   does not hit. `--self-test` fails when either fixture is missing or when the good fixture
   trips the rule.
3. Run `bash scripts/check-web-style.sh --update <id>` to create the baseline.
4. Add a unit test when the rule depends on a parser helper rather than a regex alone.

A rule is cheap to add and expensive to keep honest: if a new check would need a long list of
exceptions, it belongs in review, not in the guard.

## Boundary with knip

Knip finds unused files and exports, but not unused `cva` variant keys: those are object
properties, and callers select them dynamically (`variant={presentation.badgeVariant}`), so a
static check cannot distinguish a dead key from a value chosen elsewhere. Knip therefore
exempts only the export issue under `apps/web/src/components/ui/*.tsx`; dead namespaces and
duplicate exports are reported. Variant pruning stays a review concern. The guard owns
class-level token policy; knip owns module-level reachability.
