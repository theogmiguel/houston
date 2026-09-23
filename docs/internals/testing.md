# Testing

What the suites are, where new tests go, and how to read a failure. Commands and cadence:
[`docs/operations/development.md`](../operations/development.md).

## Where tests live

| Layer | Location | Runner |
|---|---|---|
| Daemon unit tests | `#[cfg(test)]` in `core/houston-core/src/*.rs` | `cargo test --lib <module>` |
| Daemon integration | `core/houston-core/tests/*.rs`, harness `tests/common/mod.rs` — boots a real daemon on a throwaway state dir and speaks `/ws` | `cargo test --test <name>` |
| Perf floors | `tests/perf_smoke.rs` (throughput and RSS floors, both `#[ignore]`) | `cargo test --release --test perf_smoke -- --ignored` |
| App | `src-tauri/tests/*.rs` (daemon ownership, channel flags), unit tests in `src/` | `cargo test`, and again with `--features bench` |
| Renderer | `*.test.ts(x)` beside the code, jsdom + Testing Library | `bun run test` (vitest) |
| Renderer CSS | `ui/scripts/check-css-scoping.mjs` runs headless Chromium against the *built* stylesheet | `bun run check:css` after `bun run build` |
| Safety | `scripts/check-*.sh`, hermetic, sub-second | each script, from the repo root |

Rules:

- New daemon behaviour gets an integration test. Bug fixes get a regression test that fails
  before the fix.
- Tests redirect the state dir through `HOME` (`home_dir.rs` is environment-first for this
  reason) and never touch a real channel.
- Wait on events and receipts, not sleeps. A wall-clock deadline is acceptable only for a
  liveness property, and it must be generous enough to survive a cold page cache.
- The shared renderer harness loads application modules during test collection. Keep this
  setup outside individual test deadlines: a timed-out asynchronous React `act` can remain
  pending and make every subsequent test in that file fail before rendering.
- `tracing`-capture tests call `ensure_permissive_global_default()` from
  `test_tracing_capture.rs` before their own `with_default`. Callsite interest is
  process-global: a sibling test with no subscriber votes `never` and silences that callsite
  for the whole binary. One test that forgets breaks the crate's captures (measured 4/30
  and 16/60 failure rates before the fix, 0/100 after).
- A test that reads a whole-process figure (VmRSS, thread count, context switches) is only
  meaningful if it is the only test touching that figure while it samples. `cargo test` runs
  a binary's tests concurrently by default, so `tests/idle_loops_wire.rs`'s perf tests
  serialize on a shared mutex and tear their own sessions down, waiting for threads to
  settle, before returning. A reading taken any other way is contaminated by its neighbours.
- A test that spawns a daemon binary owns a guard that stops whatever generation its channel
  dir records, so a failing test cannot leave a daemon behind — `daemon_adoption_wire.rs`'s
  `ChannelGuard` is the shape: it reads `<dir>/daemon.json` on drop and stops that pid, not
  just the supervisor or the one `Child` the test itself spawned, since a handed-off
  generation outlives both.

## Reading a failure

A known failure mode is believable only through the discriminator that matches it.
"Re-run standalone" is not universal.

| Shape | Discriminator | Not a discriminator |
|---|---|---|
| Wall-clock deadline missed on the first run after a relink | re-run **warm**; cold page-cache cost was measured at 23× (7 s cold vs 310 ms warm, same binary, idle machine) | `--test-threads=1`, running standalone |
| `perf_smoke` below floor | re-run on an **idle** machine at normal priority | any number from a busy box |
| Empty `tracing` capture buffer only when siblings run | the missing `ensure_permissive_global_default()` call | re-running the one test |
| Harness `ETXTBSY` (a concurrent spawn forks between a fixture's chmod and exec) | `--test-threads=1` — it is a within-module race, so `cargo test --lib` reproduces it | standalone |
| GUI-probe geometry (`--browser-selftest`) reads back the unrealized sentinel everywhere | `loginctl show-session` says `LockedHint=no`, then re-run; a locked screen maps no window | anything else |
| A full `ui/` run on a loaded cold machine shows N failures | re-run warm and report **both** numbers — the red one is what lets a reviewer verify the noise | reporting only the green re-run |

A shape that was *called* flaky and was not:

- A "replay proof" in an IME dedup test compared strings that could never correspond under
  real use; every isolated run was green for a reason unrelated to the claim. Deleted, not
  tuned.

## Inverted evidence

A green test whose fixture pins a state the system cannot produce is the strongest possible
argument for a false property. Three past cases gave a replacing session the *same* id the
old row had, when `Daemon::respawn` always mints a new one. Read a mock against the real
collaborator's contract, not just against its own assertions.

## Fixtures

- `ansi_flood` (`src/bin/ansi_flood.rs`) sprays heavy TUI output at maximum speed for
  throughput tests.
- Sessions launched with an explicit `cmd` run that command for every agent kind, so a
  fixture never silently launches whichever real CLI is installed.
- `HOUSTON_DISABLE_AUTO_RESTORE=1` and `HOUSTON_SAFE_MODE=1` keep a booted test
  daemon from restoring or auto-launching anything.
- `m9-baseline.sh` uses a throwaway `m9bench` channel, wiped before every run and refused if
  a live daemon holds its lock.

## Windows

The core suite must be run on Windows under both Git Bash and `pwsh` before landing a
change that touches the shell/home ladders (locally — no CI job runs the Windows core suite
today). `$SHELL` and `$HOME` feed production ladders in `daemon.rs`, `home_dir.rs` and
`ssh_config.rs`, and two tests once disagreed between the shells. A Windows-only failure in
one shell is a real finding about that ladder, not harness noise.
