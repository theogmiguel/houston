# Contributing to Houston

Pull requests are wanted. Small, scoped ones especially — a fix for one bug, one new
surface, one refactor — reviewed and merged faster than a change that tries to do several
things at once.

## Before you start

- Keep a change scoped to one user-facing improvement, bug fix or refactor. If your PR
  description needs the word "also", it is probably two PRs.
- Linux and Windows are supported release platforms. Behaviour behind a `cfg` needs an
  equivalent on the other platform, or an explicit refusal that names the platform.
- Anything that touches an agent CLI stays provider-neutral: a provider Houston doesn't
  support for that feature is refused **by name**, never silently ignored.
- UI work follows [`docs/internals/styleguide.md`](docs/internals/styleguide.md) — tokens
  over hex, the chrome constants over ad-hoc classes.
- Deeper rules on how Houston is built live in [`AGENTS.md`](AGENTS.md); read it before a
  change that touches the server, the contracts, or an agent CLI's configuration.

## Local setup

Prerequisites and the exact install commands are in the "First checkout" section of
[`docs/operations/development.md`](docs/operations/development.md).

Linux:

```sh
./scripts/dev.sh                 # dev channel, build + run
```

Windows, from PowerShell:

```powershell
./scripts/dev.ps1                # dev channel, build + run
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

**Per item, in the package or crate you touched** — cheap, run constantly:

- `src-tauri`: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, the item's own
  and touched tests.
- `apps/` and `packages/`: the package's `typecheck` and its touched tests, for example
  `pnpm --filter houston exec vp test run <files>` for the server.

**Before every push, and at the end of a work block** — the full suites. On Linux,
run Cargo inside `scripts/oom-shield.sh`. On Windows, set `$env:CARGO_BUILD_JOBS = '3'`
in PowerShell. Never run concurrent Cargo workloads.

**The workspace** (the web build comes first: `src-tauri` embeds its output):

```
pnpm -r typecheck
pnpm --filter @t3tools/web build
pnpm --filter @t3tools/contracts --filter @t3tools/shared test
pnpm --filter houston exec vp test run src/houston
node scripts/check-upstream.mjs <upstream clone> --skip apps/web
```

**`src-tauri/`**:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Tests

Tests come before code. A bug fix gets a regression test that fails before the fix and
passes after it — prefer a test that would actually catch the regression over one that
only walks the happy path.

## Pull requests

- Say what changed and why, in a sentence or two.
- One concern per PR. If the message says "also", split it.
- Before/after screenshots for anything visual, or `N/A` with a reason.
- Use a conventional title describing the resulting behaviour. Add a `## Release notes`
  section with feature, fix and improvement bullets, or explicit `None` for internal work.
  Releases group these items; legacy PR titles are a fallback requiring editorial review.
  See the [release runbook](docs/operations/release.md#release-notes) for the format.

## Releases are maintainer-only

Never include a version bump in a contribution. The four version manifests and both
lockfiles are written only by the maintainer's **Cut release** workflow.

## Licensing

By submitting a contribution, you agree it is licensed under Apache-2.0, the same licence
as the rest of the project, per clause 5 of the licence. There is no separate CLA.
