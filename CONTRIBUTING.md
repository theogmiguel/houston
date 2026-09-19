# Contributing to Houston

Pull requests are wanted. Small, scoped ones especially — a fix for one bug, one new
surface, one refactor — reviewed and merged faster than a change that tries to do several
things at once.

## Before you start

- Keep a change scoped to one user-facing improvement, bug fix or refactor. If your PR
  description needs the word "also", it is probably two PRs.
- Linux is the lead platform, and Windows must keep compiling. Behaviour behind a `cfg`
  needs a named twin on the other platform, or a named refusal — never a silent gap.
- Anything that touches an agent CLI stays provider-neutral: a provider Houston doesn't
  support for that feature is refused **by name**, never silently ignored.
- UI work follows [`docs/internals/styleguide.md`](docs/internals/styleguide.md) — tokens
  over hex, the chrome constants over ad-hoc classes.
- Deeper rules on how Houston is built live in [`AGENTS.md`](AGENTS.md); read it before a
  change that touches the daemon, the wire protocol, or hooks.

## Local setup

Prerequisites and the exact install commands are in the "First checkout" section of
[`docs/operations/development.md`](docs/operations/development.md).

```
./scripts/dev.sh                 # dev channel, build + run
./scripts/dev.sh --fresh         # stop+restart the daemon fresh
```

Full setup, the dev/release channel split, and every environment knob:
[`docs/operations/development.md`](docs/operations/development.md).

## Branch naming

`<type>/<short-description>`, using the same conventional type as the commit itself
(`fix`, `feat`, `docs`, `chore`, `refactor`, `test`). Good:

- `fix/pane-status-hooks`
- `feat/orchestration-inbox-cap`
- `docs/routine-headless-refusals`

Avoid:

- `fix-stuff`
- `my-branch`

## Before opening a PR

Run the gates for whatever you touched.

**Per item, in the crate or area you touched** — cheap, run constantly:

- `core`/`src-tauri`: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, the item's
  own and touched test binaries.
- `ui`: `bun run typecheck` plus the item's own and touched test files.

**Before every push, and at the end of a work block** — the full suites, inside
`scripts/oom-shield.sh`:

**`core/`**:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

**`ui/`** (order matters — the last two read what `build` emitted):

```
bun run typecheck
bun run test
bun run check:complexity
bun run build
bun run check:css
bun run check:bundle
```

**`bun run test`, never bare `bun test`** — the latter invokes Bun's own test runner and
fails the jsdom-based suite.

**`src-tauri/`** — test and clippy in both the default and `--features bench`
configurations, plus `cargo fmt --check`. The renderer must be built first
(`cd ui && bun run build`), before any cargo step here:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features bench -- -D warnings
cargo test
cargo test --features bench
```

## Tests

New daemon behaviour gets an integration test under `core/houston-core/tests/`. A bug fix
gets a regression test that fails before the fix and passes after it — prefer a test that
would actually catch the regression over one that only walks the happy path.

## Pull requests

- Say what changed and why, in a sentence or two.
- One concern per PR. If the message says "also", split it.
- Before/after screenshots for anything visual, or `N/A` with a reason.
- When the PR changes behaviour a user would notice, its title is the note that user will
  get — the release notes are generated from the merged PRs and list each one by its
  title. CI-only and docs-only PRs are exempt.

## Releases are maintainer-only

Never include a version bump in a contribution. The four version manifests and both
lockfiles are written only by the maintainer's **Cut release** workflow.

## Licensing

By submitting a contribution, you agree it is licensed under Apache-2.0, the same licence
as the rest of the project, per clause 5 of the licence. There is no separate CLA.
