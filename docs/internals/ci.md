# Continuous integration

`.github/workflows/ci.yml` is the only gate for pull requests to `v2` and `main`, pushes to
those branches, the nightly run and manual dispatches. It replaces the former split between
the desktop-only `ci.yml` and `v2-checks.yml`, which ran the server suites in nine area jobs
per platform and never ran the renderer's own tests.

## Jobs

| Job                | Runs on                                | Proves                                                                                                                                         |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes`          | every run                              | classifies the changed paths; every other job waits on its outputs                                                                             |
| `static`           | every run                              | workflow syntax, the safety scripts, changed-file format and lint, doc and comment hygiene, web style guards, the licence notice and inventory |
| `typecheck`        | changed code                           | `pnpm -r --no-bail typecheck` for every workspace package                                                                                      |
| `test-packages`    | workspace package changes              | package suites and the node:test script suites                                                                                                 |
| `test-server`      | server changes                         | `apps/server` `src/` and `scripts/` tests in six vitest shards                                                                                 |
| `test-web`         | web changes                            | the production renderer build and the `unit` vitest project                                                                                    |
| `test-web-browser` | web changes                            | the `browser` vitest project in four shards                                                                                                    |
| `native-linux`     | native changes, and every non-PR run   | renderer build, formatting, Clippy and `src-tauri` tests under an isolated keyring                                                             |
| `native-macos`     | native changes, and every non-PR run   | the same host checks on Apple silicon                                                                                                          |
| `native-windows`   | native changes, and every non-PR run   | the same host checks on Windows                                                                                                                |
| `server-windows`   | nightly, and pushes to `v2` and `main` | the server suites in three Windows shards                                                                                                      |
| `ci-gate`          | every run                              | the aggregate check to require on branches                                                                                                     |

`ci-gate` fails when any job failed or was cancelled, or when `changes` did not succeed. A job
skipped by the path filter counts as a pass.

## Path filtering

`scripts/ci/changes.mjs` reads repository-relative paths on stdin and prints job outputs. On a
pull request the workflow feeds it `git diff --name-only HEAD^1 HEAD` from a blobless,
depth-2 checkout, so the diff is the PR's own changes against the base tip.

The filter fails closed. An empty diff, a push, schedule or dispatch event, a change under
`.github/workflows/`, `.github/actions/` or `scripts/ci/`, and any path the rules do not
recognise all set every job output to true. A new directory can therefore never silently skip
CI; adding a rule is what makes a path inexpensive.

`docs_only` is the one output that is false when the filter fails closed. Documentation-only
PRs run `static` (doc hygiene is the check they need) and skip the heavy jobs.

Native paths are `src-tauri/`, `native/`, `assets/`, `apps/web/public/` and `.cargo/`. A web
source change is covered by `test-web`, which builds the renderer without paying for three
native platforms.

## Runner indirection

Linux jobs select their runner through repository variables:

- `CI_RUNNER_LINUX` for sharded test and native jobs; default `ubuntu-24.04`.
- `CI_RUNNER_LINUX_SMALL` for `changes`, `static`, `typecheck`, `test-packages`, `test-web` and
  `ci-gate`; default `ubuntu-24.04`.

Setting both to a faster provider is a repository-variable change. For example, the four-vCPU
Blacksmith image is `blacksmith-4vcpu-ubuntu-2404`. macOS and Windows jobs keep GitHub-hosted
runners because they prove the host compiles on those platforms.

## Drafts, nightly work and Windows

Heavy jobs skip draft pull requests; `ready_for_review` starts them, and `static` and `changes`
still run so a draft gets fast feedback. `server-windows` never runs on a pull request, so a
Windows-only failure cannot hold a review; its nightly failures are real failures and require
a fix before the next release.

## Caches

The pnpm store is cached by `actions/setup-node` inside `.github/actions/setup`. Rust builds use
`Swatinem/rust-cache` keyed per operating system, and Chromium is cached by the resolved
Playwright version. The typecheck job runs each package's own script because the root `vp run`
form collides with the web package's same-named task.

## Timing

`scripts/ci/timing-report.mjs` reads the last completed `ci.yml` runs of a branch through the
`gh` CLI and splits each job into queue time (job start minus run creation, because `gh` does
not expose a job's own creation time) and run time:

```
GH_TOKEN=... node scripts/ci/timing-report.mjs --branch v2 --runs 30
```

It prints one markdown table of per-job medians and p90 values and one row for the whole run.
Percentiles use the nearest-rank definition, so a small sample reports a real observed value.

## Local pre-push gate

`vp config` installs the dispatcher in `.vite-hooks/_` and recreates the shim for every
project-owned hook. `.vite-hooks/pre-push` runs `scripts/check-changed.ts`, which formats and
lints the branch's changed files and typechecks the affected packages when a TypeScript or
manifest file changed. It prints `nothing relevant changed` and exits 0 when the range is empty.
