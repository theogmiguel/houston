## What changed



## Why



## Linked issue

Closes #

## UI changes

<!-- If this PR changes anything visual, include before/after screenshots.
     If there are no UI changes, write N/A and say why (e.g. "backend only"). -->

## Testing



## AI disclosure

<!-- Which model, if any, wrote or assisted with this PR? Neutral, non-judgemental —
     Houston itself is built this way. e.g. "Claude Sonnet, reviewed by me" or "none". -->

## Checklist

- [ ] One concern per PR — if this description says "also", it should be two PRs
- [ ] `scripts/check-*.sh` (the safety scripts) pass
- [ ] `cargo fmt --all --check` and `cargo clippy --all-targets -- -D warnings` pass
- [ ] `cargo test` passes
- [ ] In `ui/`: `bun run typecheck && bun run test && bun run check:complexity && bun run build && bun run check:css && bun run check:bundle` pass, in that order (`bun run test`, never bare `bun test` — the latter is Bun's own runner and fails the suite)
- [ ] If behaviour changed: the title says what changed for a user, in plain language — the release notes are generated from the merged PRs and list each one by its title
- [ ] If this is a bug fix: added a regression test that fails before the fix
- [ ] No version bumps — only the **Cut release** workflow touches a version manifest
