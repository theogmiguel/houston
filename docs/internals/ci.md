# Continuous integration

`.github/workflows/ci.yml` is the only gate for pull requests to `v2`, pushes to
it and manual dispatches. It replaces the former split between
the desktop-only `ci.yml` and `v2-checks.yml`, which ran the server suites in nine area jobs
per platform and never ran the renderer's own tests.

## Jobs

| Job                | Runs on                              | Proves                                                                                                                                                  |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes`          | every run                            | classifies the changed paths; every other job waits on its outputs                                                                                      |
| `static`           | every run                            | workflow syntax, the safety scripts, changed-file format, the lint ratchet, doc and comment hygiene, web style guards, the licence notice and inventory |
| `typecheck`        | changed code                         | `pnpm -r --no-bail typecheck` for every workspace package                                                                                               |
| `test-packages`    | workspace package changes            | package suites and the node:test script suites                                                                                                          |
| `test-server`      | server changes                       | `apps/server` `src/` and `scripts/` tests in six vitest shards                                                                                          |
| `test-web`         | web changes                          | the production renderer build, its boot budget and the `unit` vitest project                                                                            |
| `test-web-browser` | web changes                          | the `browser` vitest project in four shards                                                                                                             |
| `native-linux`     | native changes, and every non-PR run | `cargo test` for the Houston 1 cleanup helper and the Linux capture helpers                                                                             |
| `server-windows`   | server changes                       | the server suites in three Windows shards                                                                                                               |
| `ci-gate`          | every run                            | the aggregate check to require on branches                                                                                                              |

`ci-gate` fails when any job failed or was cancelled, or when `changes` did not succeed. A job
skipped by the path filter counts as a pass.

## Renderer boot budget

`scripts/check-web-boot-budget.mjs` reads the web build's `.vite/manifest.json` and sums the
JavaScript and CSS a cold start loads before React mounts: the HTML entry, its static imports, and
the chunks its own dynamic imports preload (`bootstrap.ts` loads `main.tsx` at once), each with its
static imports and stylesheets. `test-web` fails when that closure exceeds `BOOT_BUDGET_BYTES`.

Code that the first paint does not need belongs behind a dynamic import. A module that boot code
imports puts every export another chunk uses into the boot closure, so a helper that start-up
code needs lives apart from heavy siblings. Raise the budget only with the reason in the commit.
Run the check locally after `pnpm --filter @houston-app/web build`; `--verbose` lists every file.

## Path filtering

`scripts/ci/changes.mjs` reads repository-relative paths on stdin and prints job outputs. On a
pull request the workflow feeds it `git diff --name-only HEAD^1 HEAD` from a blobless,
depth-2 checkout, so the diff is the PR's own changes against the base tip.

The filter fails closed. An empty diff, a push or dispatch event, a change under
`.github/workflows/`, `.github/actions/` or `scripts/ci/`, and any path the rules do not
recognise all set every job output to true. A new directory can therefore never silently skip
CI; adding a rule is what makes a path inexpensive.

`docs_only` is the one output that is false when the filter fails closed. Documentation-only
PRs run `static` (doc hygiene is the check they need) and skip the heavy jobs.

Native paths are `native/`, `apps/desktop/native/`, `assets/`,
`apps/web/public/` and `.cargo/`. Desktop source changes run the package suites and typecheck
without the renderer jobs. A web source change is covered by `test-web`, which builds the
renderer without paying for a Rust build.

## Runner indirection

Linux jobs select their runner through repository variables:

- `CI_RUNNER_LINUX` for sharded test and native jobs; default `ubuntu-24.04`.
- `CI_RUNNER_LINUX_SMALL` for `changes`, `static`, `typecheck`, `test-packages`, `test-web` and
  `ci-gate`; default `ubuntu-24.04`.

Setting both to a faster provider is a repository-variable change. For example, the four-vCPU
Blacksmith image is `blacksmith-4vcpu-ubuntu-2404`. Windows jobs keep GitHub-hosted runners
because they prove the server compiles on that platform.

## Drafts and Windows

Heavy jobs skip draft pull requests; `ready_for_review` starts them, and `static` and `changes`
still run so a draft gets fast feedback. `server-windows` gates every pull request that changes
the server, like `test-server`. Its shards pass when their failures match
`scripts/ci/windows-known-failures.json` exactly: a new failure fails the shard, and so does a
listed test that now passes, so the list only shrinks. Each shard uploads its vitest JSON report;
`node scripts/ci/windows-known-failures.mjs --update <reports...>` rewrites the `failing` list from
all three; a test seen both failing and passing on one tree goes in `flaky`, which accepts either.

## Caches

The pnpm store is cached by `actions/setup-node` inside `.github/actions/setup`. Rust builds use
`Swatinem/rust-cache` keyed per crate workspace, and Chromium is cached by the resolved
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
manifest file changed. When a `package.json`, pnpm lockfile or workspace file, `Cargo.toml` or
`Cargo.lock` changed, it also runs `scripts/check-third-party-licenses.sh`, the same inventory diff
the `static` job runs. It prints `nothing relevant changed` and exits 0 when the range is empty.

## Branch rules and dependency updates

`v2` takes changes through pull requests. Its ruleset requires `ci-gate` on a branch that is up to
date with `v2`, needs no approving review, and blocks force pushes and deletion; repository admins
can bypass it in an emergency. There is no merge queue, nightly run or CODEOWNERS file.

`.github/dependabot.yml` opens one weekly pull request per ecosystem (npm, GitHub Actions, Cargo)
for minor and patch updates, and one per major update. A dependency pull request fails `static`
until the licence inventory is regenerated with `node scripts/gen-third-party-licenses.mjs`.

## Lint ratchet

The tree carries lint errors that predate the gate, so `scripts/ci/lint-ratchet.mjs` compares each
file's error count with `scripts/lint-baseline.json`. A file may keep or lower its count; an
increase, or any error in a file with no entry, fails and prints the new errors with their
positions. `static` runs it over the whole tree (about 16 s); the pre-push gate runs it on the
changed files. After fixing errors, `node scripts/ci/lint-ratchet.mjs --update` rewrites the
baseline so the allowance only falls.
