# Executor brief: Houston design B ("Native") rollout

You implement a renderer redesign of Houston, one commit at a time. A reviewer (your parent pane) checks every commit's screens against the reference mock before you start the next one. Work only on the commit you are asked for, then submit and wait.

## Read first

- Plan (commits, files, snippets): `/tmp/claude-1000/-home-theo-ProjetosPessoais-Houston/828dbba9-fc72-4d93-80ed-aaebc246e156/scratchpad/plan-design-b.md`
- Reference mock (open in a browser or read the CSS tokens at the top): `/tmp/claude-1000/-home-theo-ProjetosPessoais-Houston/828dbba9-fc72-4d93-80ed-aaebc246e156/scratchpad/mocks/houston-mocks.html`
- Repository rules: `AGENTS.md` (repo root) and `docs/internals/styleguide.md`. They win over this brief if they conflict; say so in your report.

Never copy the plan, the mock or screenshots into the tracked tree.

## Where you work

Your cwd is a Houston worktree on branch `feat/design-native`. Renderer code lives in `ui/src/renderer/src`. You do not need Cargo for this work.

## Hard rules

- Never run `git stash`, `git reset --hard`, `git checkout -- .`, rebase, or force-push. Never push. Several agents share the machine.
- Stage explicit paths only (`git add path/a path/b`); never `git add -A`, `git add .` or `commit -a`.
- One commit per phase, conventional message, for example `feat(ui): design tokens for the native look`. No `Co-Authored-By`, no session links, no generated-by footers.
- Never touch `~/.houston` (installed release channel), never start or kill any Houston daemon, never run `pkill`/`killall`. Do not launch the desktop app; the reviewer does live checks.
- Do not delete or weaken a test to make it pass. Tests that pin old geometry or colours get updated to the new values with the same intent.
- Feature `className` values carry layout only; visual roles live in `ui/src/renderer/src/components/ui/` with a `ui-primitives` specimen case.
- Comments explain code, never history (no "phase", "plan", "per the mock").
- Error messages include the offending value and the expected shape. New tunable constants get a one-line rationale.
- Heavy commands run under `nice -n 19 ../scripts/oom-shield.sh` (from `ui/`) or `nice -n 19 ./scripts/oom-shield.sh` (from the root).

## Gate for every commit

From `ui/`: `bun run typecheck`, `bun run test` (not `bun test`), and every `../scripts/check-*.sh` your change can affect (run all of them if unsure). Then capture the harness:

```
node ../scripts/capture-stories.mjs /tmp/claude-1000/-home-theo-ProjetosPessoais-Houston/828dbba9-fc72-4d93-80ed-aaebc246e156/scratchpad/review/<commit-number>
```

(The script is created in commit 0.) Fix every failure before submitting. If a failure is pre-existing on `main`, prove it by running the same command against `main` and report it instead of fixing it.

## Report (pane_submit)

```
commit: <sha> <subject>
files: <paths changed>
gate: <each command> -> pass/fail (paste failing output)
captures: <dir> (<n> PNGs, <n> failures)
deviations: <anything you did differently from the plan and why>
questions: <anything that needs the reviewer>
```

Ask with `pane_report kind=question` when a decision is not covered by the plan or the mock; do not guess on visual choices.

## Commit 0 (do this now)

1. Harness stories under `pr-panel/*`, `pr-page/*` and `prs/*` (125 of them) render blank with `TypeError: Cannot read properties of undefined (reading 'forge')`. Find the root cause (the harness lives in `ui/harness/` and the stories are registered from the renderer). Fix the fixture so it represents a state the daemon can actually produce; do not paper over it with optional chaining in product code unless the product can really receive that shape (then say why). Add a regression test that renders one `prs/*` story and fails before the fix.
2. Add `scripts/capture-stories.mjs <outDir> [filterRegex]`: boots `vite` for the harness on a free port, opens every story listed on the harness index in both chrome themes (`?story=<name>&theme=graphite|paper`), 1280x800, waits for `document.fonts.ready`, writes `<outDir>/<theme>/<story>.png`, prints the failure list, exits non-zero if any story fails to render. Use Playwright from `ui/node_modules`; if its bundled browser cannot launch, fall back to `/usr/bin/google-chrome`. Reference implementation to port (adapt to repo style, add a header comment with usage): `/tmp/claude-1000/-home-theo-ProjetosPessoais-Houston/828dbba9-fc72-4d93-80ed-aaebc246e156/scratchpad/shoot-all.mjs`. Document the command in `docs/operations/development.md` where UI captures are described (keep `scripts/check-doc-hygiene.sh` green).
3. Run the gate, then capture the full "before" set into `.../scratchpad/review/0`.
