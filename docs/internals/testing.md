# Testing

What the suites are, where new tests go, and how to read a failure. Commands and cadence:
[`docs/operations/development.md`](../operations/development.md).

## Where tests live

| Layer | Location | Runner |
|---|---|---|
| Server | `*.test.ts` beside the code under `apps/server/src`; Houston's under `src/houston/` | `pnpm --filter houston exec vp test run <files>` |
| Contracts and shared | `packages/contracts/src`, `packages/shared/src` | `pnpm --filter @t3tools/contracts --filter @t3tools/shared test` |
| Renderer | `*.test.ts(x)` beside the code under `apps/web/src` | the package's `test` script |
| Host | unit tests in `src-tauri/src` | `cargo test` in `src-tauri` |
| Repository tooling | `scripts/*.test.mjs`, `scripts/test-*.py` | `node --test`, `python3` |
| Safety | `scripts/check-*.sh`, hermetic, sub-second | each script, from the repository root |

Rules:

- Tests come before code. A bug fix gets a regression test that fails before the fix.
  Fixtures represent states the system can produce; a composed fixture is labelled as
  composed.
- A filter that matches no package, and a `-t` pattern that matches no test, exit 0 without
  running anything. Confirm with `--reporter=verbose` that a proof ran.
- Server code that reaches a provider, GitHub, Notion, Slack or the keychain is tested against
  replay fixtures, local fakes and the in-memory keychain layer, never the real service. Only
  `server.ts` provides the live keychain.
- Host tests that touch agent CLI configuration or the channel directory build them under a
  temporary home (`test_home::isolate`, or a `tempfile` directory passed in explicitly) and
  never read the real one. A test that needs an agent CLI puts a fake on the `PATH` it hands
  the code under test; it never runs the real CLI.
- `tracing`-capture tests call `ensure_permissive_global_default()` from
  `sys/test_tracing_capture.rs` before their own `with_default`. Callsite interest is
  process-global: a sibling test with no subscriber votes `never` and silences that callsite
  for the whole binary (measured 4/30 and 16/60 failure rates before the fix, 0/100 after).
- Wait on events and receipts, not sleeps. A wall-clock deadline is acceptable only for a
  liveness property, and it must be generous enough to survive a cold page cache.
- A test that starts a process owns it and stops it by the handle it holds, on success and
  failure alike.

## Reading a failure

A known failure mode is believable only through the discriminator that matches it.
"Re-run standalone" is not universal.

| Shape | Discriminator | Not a discriminator |
|---|---|---|
| Wall-clock deadline missed on the first run after a relink | re-run **warm**; cold page-cache cost was measured at 23× (7 s cold vs 310 ms warm, same binary, idle machine) | `--test-threads=1`, running standalone |
| Empty `tracing` capture buffer only when siblings run | the missing `ensure_permissive_global_default()` call | re-running the one test |
| `ETXTBSY` from a fixture script (a concurrent spawn forks between its chmod and exec) | `--test-threads=1` reproduces it as a within-binary race | standalone |
| A full run on a loaded cold machine shows N failures | re-run warm and report **both** numbers — the red one is what lets a reviewer verify the noise | reporting only the green re-run |

## Inverted evidence

A green test whose fixture pins a state the system cannot produce is the strongest possible
argument for a false property. Read a mock against the real collaborator's contract, not just
against its own assertions, and build fixtures from what the producing code writes.
