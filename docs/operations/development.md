# Development

Everything a contributor needs from a fresh checkout to a green gate:
building, running, the dev/release channel split, the check cadence, and
what each OS's build produces. Production launch is `scripts/start.sh`
(`docs/operations/release.md`); the WSL2 testbed is
`docs/operations/linux-testbed.md`.

## First checkout

Prerequisites, installed once on a bare Debian/Ubuntu machine (another
distribution's package names will differ):

1. Rust toolchain — install via rustup, `https://rustup.rs` (CI uses the
   `stable` toolchain).
2. [Bun](https://bun.sh), used for renderer dependencies and scripts.
3. A current Node.js release. Several repository gates execute `.mjs` files
   with `node` directly.
4. Google Chrome installed at `/usr/bin/google-chrome`. The CSS scoping gate
   launches that exact binary through Playwright.
5. The pinned Tauri CLI:
   `cargo install tauri-cli --version 2.11.4 --locked`.
6. Linux system packages:

   ```sh
   sudo apt-get install -y \
     build-essential pkg-config clang libclang-dev cmake nasm \
     libdbus-1-dev libudev-dev libwebkit2gtk-4.1-dev libasound2-dev \
     librsvg2-dev patchelf libfuse2 libayatana-appindicator3-dev \
     gnome-keyring dbus-x11
   ```

   (`patchelf` and `libfuse2` are only needed to bundle an AppImage, not
   to run `dev.sh`). Ubuntu 22.04 is the release baseline, and it names the
   FUSE 2 runtime `libfuse2`; the `libfuse2t64` rename is 24.04's.
   `gnome-keyring` and `dbus-x11` provide the unlocked Secret Service session
   required by the full core test suite.
7. Renderer dependencies, once per clone and whenever `ui/bun.lock` changes:
   `(cd ui && bun install --frozen-lockfile)`.

Then:

```
./scripts/dev.sh                 # dev channel, build + run
./scripts/dev.sh --fresh         # stop+restart the daemon fresh
```

The development script builds the renderer (`cd ui && bun run build`),
the debug daemon and supervisor (`cargo build --bin houston-core --bin
houston-supervisor` in `core`), the debug app (`cargo build` in
`src-tauri`), then `exec`s `src-tauri/target/debug/houston-tauri --channel
<target>`. The app connects to a running daemon for the target channel or
spawns one detached, through `houston-supervisor` on Linux — it no longer
hosts the daemon in-process. `HOUSTON_DAEMON_BIN_DIR` is exported to
`core/target/debug` first, so the app's connect-or-spawn finds the debug
sidecars there instead of assuming a packaged layout beside its own binary.

Development state lives in `~/.houston-dev`; see the next section for why
that matters before you run anything else.

## Dev channel vs release channel

**Important safety boundary.** A channel is an isolated state universe: its
own SQLite DB, `daemon.json`, and hooks.

| Channel | State dir | How you get it |
|---|---|---|
| `release` | `~/.houston` | The installed app's live state. Only via explicit `--channel release`. |
| `dev` | `~/.houston-dev` | `dev.sh`'s unconditional default — a bare `./scripts/dev.sh` always lands here. |
| named | `~/.houston-<name>` | `--channel <name>`, validated against `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$` (mirrors `paths.rs::validate_channel`; checked in bash too, since `dev.sh` writes at the state dir before the daemon ever runs). Example: `m9bench`. |

`~/.houston` is the installed app's live state — two daemons pointed at the
same directory don't share it, they corrupt it (two SQLite writers on one
file, and whichever daemon's `daemon.json` was written last captures every
hook). Never point a dev daemon at it, and never pass `--channel release`
unless you mean to drive the installed app's own daemon; the app resolves its
target channel from `--channel` alone, and `dev.sh` prints a loud warning
naming the live state dir before proceeding when you do.

`scripts/dev.sh --fresh` is the sanctioned restart — it requests an orderly
`daemon_shutdown` over `/manage` (or a live handoff, on Linux, that swaps the
running binary out without dropping any session) and waits, identity-checked,
for the old pid to actually exit. Never a bare kill. It refuses when the
invoking shell is itself a pane on the **same** target channel — restarting
would kill the shell running the script, and every other session on that
channel, mid-script. Cross-channel `--fresh` (an installed-app pane
restarting `dev`) is allowed and is the normal way to work.

`daemon.json` (owning PID and friends) and `daemon.lock`
(`houston_core::lock::acquire_exclusive`, `LOCK_FILE_NAME = "daemon.lock"`, a
`flock`-based advisory lock) both live in the channel's state dir. The daemon
refuses to boot when another process holds the target channel's lock, naming it.

`HOUSTON_SESSION` is set inside a Houston pane; it's what the `--fresh`
refusal above uses to detect "this shell is itself running inside a pane on
the channel I'm about to restart."

## Running it

```
./scripts/dev.sh                 # dev channel, build + run
./scripts/dev.sh --fresh         # stop+restart the daemon fresh
./scripts/dev.sh --channel NAME  # target a named channel instead of dev
./scripts/dev.sh --print-target  # print resolved channel/state dir, no side effects
```

Windows: `scripts/dev.ps1` is a line-for-line port. Differences forced by the
platform: ASCII-only output, no `exec` (runs as a foreground child and exits
with the app's code), case-sensitive flag matching, `Set-StrictMode` standing
in for `-u`.

**No hot reload.** The renderer is a built artifact. Re-run the development
script after a renderer edit so the app embeds the current output.

### `scripts/oom-shield.sh`

Runs a command inside a transient `systemd-run --user --scope` with capped
memory and lowered priority, so `systemd-oomd` has a smaller victim than your
whole terminal scope.

```
./scripts/oom-shield.sh <command> [args...]
```

- **Caps**: `MemoryHigh=10G`, `MemoryMax=12G` (override via
  `OOM_SHIELD_MEMORY_HIGH`/`OOM_SHIELD_MEMORY_MAX`). Receipted against a
  measured cold-build peak of 4141.1 MiB on a 31 GiB/12-core machine —
  `MemoryMax` is ~2.97× that peak, `MemoryHigh` ~2.47×. Swap is uncapped by
  default (`OOM_SHIELD_MEMORY_SWAP_MAX` opts in).
- Applies `nice -n 19` to the wrapped command unconditionally.
- A second invocation *waits* on a global per-user `flock`, announcing
  itself, rather than running concurrently — the shield bounds one scope,
  not the sum of two.

**Never run two cargo workloads concurrently**, shielded or not — the shield
bounds each scope, not their sum; two shielded builds together can still push
the user slice past oomd's pressure threshold.

### Cargo dev profiles

`core/Cargo.toml` and `src-tauri/Cargo.toml` both set
`[profile.dev] debug = "line-tables-only"` and
`[profile.dev.package."*"] debug = false`: dependencies get no debug info
(never stepped into), workspace code keeps line tables for exact backtraces
and test failure locations. Full DWARF for a real debugging session:

```
CARGO_PROFILE_DEV_DEBUG=2 cargo build
```

Rationale: full DWARF for the whole dependency tree previously ballooned
`target/` into the tens of GB (measured 27 GB in `core/`, 25 GB of it debug
artifacts; 22 GB in `src-tauri/`, doubled there because gates build both the
default and `--features bench` configurations).

### Env knobs (developer-facing)

| Var | Effect |
|---|---|
| `HOUSTON_SAFE_MODE=1` | Turns on every individual safe-mode flag below at once. |
| `HOUSTON_DISABLE_AUTO_RESTORE=1` | Skips the normal boot-restore policy; every session comes back as a deferred husk instead of respawning its PTY. |
| `HOUSTON_RESTORE_BUDGET=<n>` | How many sessions boot at once at startup; the rest come back deferred. `0` is valid (defers every husk). Capped at `RESTORE_BUDGET_MAX` (500) — a value above the cap is rejected, naming the cap and what was asked for. |
| `HOUSTON_SHELL_INTEGRATION=0` | Kill-switch for the daemon's shell-integration injection. |
| `HOUSTON_DEVTOOLS=1` | Opens the webview devtools on launch (`src-tauri/src/main.rs`). |
| `RUST_LOG` | Standard `tracing`/`env_logger`-style filter, read by the daemon's logging setup. |
| `TR_DEBUG_PTY_DUMP=<dir>` | Resolved once; when set, dumps raw PTY bytes to that directory for debugging. |
| `HOUSTON_DAEMON_BIN_DIR=<dir>` | Where connect-or-spawn looks for `houston-core` (and, on Linux, `houston-supervisor`) instead of beside the app's own binary. Set by `dev.sh` to `core/target/debug`; unset in a packaged install, where the sidecars are frozen copies beside `houston`. |

`HOUSTON_DISABLE_SWARM_AUTOLAUNCH`, `TR_BENCH_RESULTS_PATH`, and
`TR_BENCH_WRITE_BURST_MS` are bench-harness-only knobs
(`scripts/m9-baseline.sh`) — not something you set for ordinary dev work.

### When the wire changes

Daemon and UI ship wire changes in the same commit, with one
`PROTOCOL_VERSION` bump and `protocol/protocol.md` updated alongside. The
committed TypeScript bindings need regenerating:

```
./scripts/gen-protocol-types.sh
```

This wipes `ui/src/renderer/src/houston/generated/` then runs
`TS_RS_EXPORT_DIR=$OUT cargo test -p houston-protocol --features ts-gen
export_bindings --quiet` (`ts-gen` is an optional Cargo feature on
`houston-protocol`). It then hand-extracts several `pub const`s via `sed` and
re-emits them as `PROTOCOL_VERSION.ts` and `DEFAULTS.ts`, because `ts-rs`
exports types but not consts — covering `PROTOCOL_VERSION`,
`DEFAULT_RMS_FLOOR`, the Routines caps, the v70
daemon knobs (restore budget, mailbox retention, orchestration cap,
ignore-glob caps), `AGENT_PURPOSE_MAX`, and the usage-window constants. Each
extraction hard-fails if the constant can't be found — a silent empty value
would be worse than a build break.

`./scripts/check-protocol-sync.sh` (one of the safety scripts below) then
verifies daemon, UI, and `protocol/protocol.md` all agree on
`PROTOCOL_VERSION`.

## Checks

### Cadence

**Per item** (in the crate/area actually touched) — cheap, run constantly:

- `core`/`src-tauri`: `cargo fmt` + `cargo clippy --all-targets -- -D
  warnings` + the item's own and touched test binaries (`cargo test --lib
  <module>`, `cargo test --test <name>`).
- `ui`: `bun run typecheck` + the item's own and touched test files
  (`bun run test -- <name>…`).

**Before every push and delivery** — the full suite, always
inside `scripts/oom-shield.sh`:

- `core`: full `cargo test`.
- `ui`: full `bun run typecheck` + `bun run test` + `bun run check:complexity` +
  `bun run build` + `bun run check:css` + `bun run check:bundle`, in that order
  (the last two read what `build` emitted).

New daemon behaviour gets an integration test in
`core/houston-core/tests/`. Bug fixes get a regression test that fails
before the fix.

### Full gate commands

**`core/`**:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

(Wrap `cargo test` in `dbus-run-session` with `gnome-keyring-daemon
--unlock` if `voice::cloud`'s Secret Service tests need a private session
bus locally.)

**`ui/`** (order matters):

```
bun run typecheck         # tsc --noEmit && tsc --noEmit -p p5-harness
bun run test              # vitest run
bun run check:complexity  # the .tsx cyclomatic-complexity ratchet
bun run build             # vite build
bun run check:css         # reads the emitted stylesheet — must run after build
bun run check:bundle      # reads bundle-stats.json — must run after build
```

`bun run test`, never bare `bun test` — `bun test` invokes Bun's own test
runner, which fails the jsdom-based suite.

`check:complexity` is a `ui` gate rather than one of the safety scripts below
because a decision-path count needs a real parse, not a text search: it shells
out to `oxlint` (pinned exactly in `package.json`, one rule armed via `-A all
-D complexity`, no config file in the tree) and ratchets the result against
`ui/complexity-baseline.json` — one pin per file, holding its over-ceiling
function count and its worst function's score, both only ever falling. A file
absent from the baseline must have zero. **Scope is `.tsx` only**: the same
scan over `.ts` flags `writeQueue.ts`'s `findSafeSplit` (a VT
escape-sequence state machine) and `tree.ts`'s `isNode` (a
discriminated-union validator), which score high by being correct — the metric
cannot tell irreducible states from accidental ones, and component bodies are
where the accidental branches land. `--baseline` prints a fresh block.
~0.1 s over 109 files, so it belongs in the per-item loop too.

**`src-tauri/`** — test + clippy in *both* the default and `--features bench`
configurations, plus `cargo fmt --check`:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features bench -- -D warnings
cargo test
cargo test --features bench
```

The renderer must be built first (`cd ui && bun run build`), before **any**
cargo step here including clippy: `tauri::generate_context!()` resolves
`build.frontendDist` at **compile time**, and without `ui/out/renderer`
present the proc macro panics.

### The safety scripts

Hermetic, sub-second, text-search invariants. Twenty-five of these run on every
push and every PR, in `ci.yml`'s `safety-checks` job — one of four CI now
runs; see "What CI runs" below for the other three, and the Cadence section
above for what still runs only locally. The last row,
`check-third-party-licenses.sh`, is not a text search: it regenerates the
committed inventory and runs in its own `licence-inventory` job.

| Script | Enforces | Mechanism |
|---|---|---|
| `check-watchdog.sh` | tauri's `tracing` feature stays off; no `SystemTime` outside `watchdog/clocks.rs`; no blocking window getter off the main thread | `cargo tree` feature grep + `grep -rln SystemTime` + a pattern scan for blocking getters |
| `check-dev-channel.sh` | `dev.sh`'s channel-resolution invariants (inherited env never wins, `--channel` validation, `--print-target` has zero side effects) | Runs `dev.sh --print-target` repeatedly inside a throwaway sandbox `$HOME` under a timeout, asserting printed channel/state-dir and rejection messages |
| `check-kill-guard.sh` | `kill(2)` never receives an unchecked pid — only `core/houston-core/src/pid.rs` may call it | `grep -rn 'libc::kill('` excluding `pid.rs`; also bans `nix::sys::signal`/`syscall(`; Windows twin bans `OpenProcess(`/`TerminateProcess(`/`taskkill` outside `pid.rs` |
| `check-protocol-sync.sh` | daemon, UI, and doc all agree on `PROTOCOL_VERSION` | Extracts the version from `houston-protocol/src/lib.rs`, `PROTOCOL_VERSION.ts`, and `protocol/protocol.md`'s header; fails if any differ |
| `check-loop-spawn-sync.sh` | both daemon hosts (`houston-core/src/main.rs`, `src-tauri/src/daemon_host.rs`) call the single `spawn_background_loops` helper | Text search for the helper's definition and each call site — deliberately not a real parser |
| `check-title-tooltip-guard.sh` | native `title=` DOM tooltips vs. component `title` props (visible headings) are not confused, and the remaining native `title=` only ever shrink toward `Tooltip` | Scan over `.tsx` for capitalised JSX tags carrying `title=`, checked against an explicit component-props allowlist; a third check counts native lowercase-element `title=` per file against a ratchet |
| `check-spawn-window.sh` | every production spawn goes through `houston_core::spawn` (`CREATE_NO_WINDOW` on Windows) | Checks `clippy.toml` disallows raw `Command::new`; checks `spawn.rs` sets the flag; asserts it's **not** applied to the PTY's `portable_pty::CommandBuilder` |
| `check-icon-imports.sh` | raw `lucide-react` imports live only in `components/icons.tsx` | `grep` over `ui/src` excluding tests and `icons.tsx`, checked against an allowlist |
| `check-native-select.sh` | no native `<select>` in the renderer (its popup is an unstyled GTK window on Linux/WebKitGTK) | `grep` over `ui/src` excluding tests and `Select.tsx`, comments stripped first |
| `check-native-input.sh` | no native `<input type="checkbox">`/`<input type="radio">` in the renderer (its box is drawn by the OS theme, never ours) | `grep` over `ui/src` excluding tests, comments stripped first; no exemptions — `Toggle`/`Segmented` cover both shapes |
| `check-menu-descriptions.sh` | a menu item's description line wraps or truncates on purpose, never an unbounded `whitespace-nowrap`/`truncate` or no wrapping class at all | scans each `role="menuitem"` block for a `<strong>` label followed by a `<span>`/`<small>`/`<p>` description, checked against its own `className` |
| `check-doc-hygiene.sh` | the docs tree keeps its shape: Markdown only in the allowed set, with no dates, phase numbers, other product names or dead pointers | `git ls-files` against an allowlist regex, then `grep` per rule |
| `check-comment-hygiene.sh` | a comment block is at most three lines, and names no date, plan number, other app or person | perl scan of comment text only (string literals excluded); also runs per edited file from `.claude/settings.json`'s `PostToolUse` hook, so the agent sees the failure while the edit is in front of it |
| `check-type-scale.sh` | text sizes come from the eight-step ladder: no file names a size at all, and no raw `text-xs`/`sm`/`base` utility | perl scan of `ui/src` for any bare `text-[N<unit>]` literal and the raw utility; no ratchet and no exceptions — `text-[length:var(--tr-text-*)]` is the destination, and `text-[var(--colour)]` stays legal because the utility is overloaded |
| `check-label-tracking.sh` | the `label` step's 0.1em tracking (`--tr-text-label-tracking`) always pairs with its own uppercase transform in the same class string — a tracked run with no transform nearby is sentence/title-case text wearing the wrong step | `git ls-files` + `grep` over `ui/src/renderer/src/**/*.{ts,tsx}` for `tr-text-label-tracking`, checking a small line window around each hit for `tr-text-label-transform`/`uppercase`; no ratchet — the fix is always to move the run to the `small` step |
| `check-control-metrics.sh` | a control's height comes from a `--h-*` token, not a hand-typed pixel | perl scan in three scopes: dimension literals inside `<button>`/`<input>`/`<select>`/`<textarea>`/`<a>` attributes and heights in `*Chrome.ts` files, both against a per-file ratchet that only shrinks; plus an absolute rule with no baseline — a height literal spelling a control-ladder value (22/26/28) anywhere under `ui/src`. Width and 44 are excluded so a coincidence does not become a coupling; `components/hitTarget.ts`'s density floor is exempt by name |
| `check-radius-tokens.sh` | a corner radius comes from a `--tr-radius-*` rung, not a hand-typed pixel and not the framework's own `rounded-sm`/`md`/`lg`/`xl` | perl scan of `ui/src` `.ts`/`.tsx`/`.css` (comments stripped) for `rounded-[Nunit]` on any corner, `border-radius: Nunit` in CSS, and the framework utilities — the last conditional on `tailwind.css`'s `@theme`, which the script reads: a `--radius-<step>` mapped onto a `--tr-radius-*` token stands the rule down for that step, unmapped it is a fourth source of truth. Per-file ratchet that only shrinks. `rounded-full`/`-[50%]`/`-none` are exempt — a circle is a shape, not a rung, and zero cannot drift |
| `check-spacing-tokens.sh` | a stack's rhythm comes from the container's `gap-*`, not a directional margin on the children | perl scan of `ui/src` for `mt-`/`mr-`/`mb-`/`ml-` at any value — bare step, arbitrary length or `[var(--space-*)]` token — against a per-file ratchet that only shrinks. Four exemptions by construction rather than by baseline: `-auto` (alignment, which no gap expresses), a zero value (a reset of somebody else's margin), a negative value (a pull into overlap) and the `[&_…]:` descendant variant (markdown output we did not author, whose rhythm is deliberately non-uniform). `m-`/`mx-`/`my-` are excluded on the evidence: every one in the tree is an inset, a separator's own air, centring or a nudge, never sibling rhythm |
| `check-icon-metrics.sh` | a glyph's size and stroke come from its type rung, not a hand-typed number: no `size=`/`strokeWidth=` prop on any glyph | perl scan of `ui/src` for glyph-named JSX tags carrying either prop, plus props objects that spell one; no ratchet and no allowlist — `components/icons.tsx` (the defaults that DEFINE the set) and `IconTile` (a container with a named tile scale) are the only exemptions |
| `check-shadow-recipes.sh` | a shadow recipe comes from a token or a named constant in `components/shadowChrome.ts`, never a hand-typed px length or colour | perl scan of `ui/src` for every `shadow-[...]`; strips `var()` references (with or without a fallback) and `${CONSTANT}` interpolations, and fails if anything is left over; no ratchet and no allowlist |
| `check-ellipsis.sh` | user-facing text uses the real ellipsis character (`…`), never ASCII `...` | perl scan of `ui/src` `.ts`/`.tsx` (comments and test files stripped) plus `index.html`, for a `...` not immediately followed by an identifier char / `(` / `[` / `{` / `)` (the spread/rest shapes); no ratchet and no allowlist |
| `check-focus-visible.sh` | a class string that kills the default `outline` (`outline-none`, any variant) repaints its own `focus-visible:` state — never left with no visible focus indicator | perl scan of `ui/src` (comments stripped) for every class-string literal containing `outline-none`, failing unless it also carries a `focus-visible:` (direct, `after:`, or `[&_…:focus-visible]:`) declaration painting `shadow-`/`ring-`/`border`/`bg-`/a real `outline`; per-file exemption count, ratchets down only |
| `check-ratchets-only-tighten.sh` | a baseline pin may fall, never rise: the shrink-only ratchets (`check-radius-tokens`, `check-control-metrics`, `check-spacing-tokens`, `check-focus-visible`, `ui/complexity-baseline.json`) cannot be loosened to make a gate green | extracts every `path N` pin from each `BASELINE=(…)`/`EXEMPT_COUNTS=(…)` block and each JSON `{count, worst}`, then diffs against a ref — `origin/$GITHUB_BASE_REF` on a PR, `HEAD~1` on a push, `HEAD` locally (so an uncommitted pin edit is caught while it is still in the working tree). The root commit records the first baseline because it has no parent. A raised number or an unpinned path fails; a fall or a deletion passes; an added entry that pairs with a removed one of the same value is read as a rename. Every other unresolvable ref fails rather than skipping the check |
| `check-mutations.sh` | every covered check proves it fires: a guard whose regex stopped matching reports "ok" forever, and the failure mode is silence | runs `scripts/mutations/<check>.sh` for each covered gate; each points the real check at a broken fixture under `scripts/mutations/fixtures/` (through its `SCAN_ROOT` override) and asserts the check failed **and named the planted violation** — a bare non-zero exit would also come from a stale baseline and prove nothing. Coverage is an inverse ratchet (`MIN_COVERED`) that must be raised when a mutation is added; the uncovered checks are printed on every run |
| `check-empty-state-action.sh` | an empty state offers the action its copy names — copy that says "Start a chat" while the control lives in some other chrome fails | scans `ui/src` for elements with an empty-ish `data-testid` (`*empty*`/`*no-matches*`/`*unselected*`), requires `<button`, `<a `, or an `<EmptyState` render in the subtree whenever the copy opens with an imperative; `EmptyState`'s own `action` is required BY TYPE so tsc guards that half; three reasoned testid exemptions |
| `check-third-party-licenses.sh` | the committed inventory of every third-party package in the binaries (`src-tauri/resources/third-party-licenses.json`) matches the dependency graphs the tree resolves to | runs `scripts/gen-third-party-licenses.mjs --out <tmp>` and diffs the deterministic output against the committed file; a difference names the differing line count and only the first diff lines, never the whole 1.4 MB file |

### What CI runs

| Job | Runs on | What it does |
|---|---|---|
| `safety-checks` | every PR, and every push to `main` except a docs-only change (`**/*.md`, `docs/**`, `.gitignore`, `LICENSE`) | The twenty-five hermetic, sub-second text-search scripts above |
| `renderer-checks` | every PR, and every push to `main` except a docs-only change | `ui`'s `bun run typecheck` and `bun run test` |
| `core-checks` | every PR, and every push to `main` except a docs-only change | `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test --lib`, all against `core/Cargo.toml` |
| `licence-inventory` | every PR, and every push to `main` except a docs-only change | regenerates `src-tauri/resources/third-party-licenses.json` and diffs it against the committed copy (`scripts/check-third-party-licenses.sh`) |

The integration suites (`core/houston-core/tests/`, which need a real PTY, a
keyring or an unlocked session), the `src-tauri` gates, and the
load-sensitive gates below all stay local — none of them fit a hermetic
runner, and the Cadence section above is what actually runs them.

Two more freshness gates exist outside this set — they need build output CI's
hermetic job doesn't have, and run only at build/install time:

- `check-renderer-fresh.sh` — build-time, called by `build-app.sh`. Compares
  `PROTOCOL_VERSION.ts`/`lib.rs` against `ui/out/renderer/index.html`'s mtime.
- `check-binary-fresh.sh` — install-time, called by `install-desktop.sh`.
  Mtime-compares the release binary against `core/houston-core/src`,
  `core/houston-protocol/src`, `src-tauri/src`, both `Cargo.toml`/`Cargo.lock`,
  and `tauri.conf.json`.

Three more scripts exist as standalone, on-demand guards — hermetic and
sub-second, but not wired into the CI job and not run automatically:
`check-button-recipes.sh` (button-recipe overlays depend on the shared
`.btn` base class), `check-ghostty-vt-pin.sh` (the vendored terminal-engine
WASM matches its build pin), and `check-icon-tight-cuts.sh` (prints, never
fails, the icon set's tight-cut coverage). Run any of them by hand when
touching the area they cover.

## Maintainer-only: load-sensitive gates

These need a release build and an idle machine; they are not part of
`ci.yml` and are not something a contributor runs on every change.

### `perf_smoke`

`core/houston-core/tests/perf_smoke.rs`, `#[ignore]` by default:

```
cargo test --release --test perf_smoke -- --ignored --nocapture
```

- **Throughput floor**: `MIN_MIB_PER_SEC = 5.0` — an ANSI-flood test spraying
  64 MiB of heavy TUI output through the full daemon→WebSocket path,
  asserting sustained throughput at or above this floor.
- **RSS regression ceiling**: `RSS_REGRESSION_CEILING_MIB = 150.0` — not a
  hard budget (the daemon measured 99.9–111.1 MiB at baseline against a
  50 MiB target it never met), but ~1.5× the measured baseline peak: wide
  enough not to flap, tight enough to catch a new unbounded buffer. Ten
  concurrent 8 MiB floods drive it.

Run at **normal priority** (`nice` would starve its drain loop) and on an
**idle machine only** — it is load-sensitive by roughly 90×, so a failing
number from a busy box is no evidence either way. Linux-only, and run locally
(not part of `ci.yml`'s `safety-checks` job).

Sibling test `memory_perf_smoke` gates the memory write-path floor the same
way, also `--ignored`, also run locally.

### `idle_loops_wire`

`core/houston-core/tests/idle_loops_wire.rs`, the detached daemon's idle
budget, `#[ignore]` by default and `--test-threads=1` because each reads a
whole-process figure:

```
cargo test --release --test idle_loops_wire -- --ignored --nocapture --test-threads=1
```

- **P3, idle scheduling**: ≤ 15 thread-summed context switches per minute with no
  client, no session and one routine armed far in the future (so the reap rule
  does not end the run). Measured 0 over 20 s on the complete daemon, against a
  211/min baseline before the idle profile.
- **P4, idle RSS**: ≤ 30 MiB at zero sessions (measured 11.9 MiB) and ≤ 64 MiB
  with twelve idle shells whose emulators are saturated at their full history
  budget (measured 49–51 MiB across two runs, 29 threads). Closing the twelve
  returns the daemon to within 3.5 MiB of baseline once the PTY reader threads
  wind down, about 8 s.

Same rules as `perf_smoke`: release build, idle machine, run locally.

### `scripts/m9-baseline.sh`

The rendering-path frame-latency baseline:

```
./scripts/m9-baseline.sh          # RUNS=5 by default
```

- Requires `src-tauri/target/release/houston-tauri` built with
  `--features bench`.
- M9's flood start/teardown go through `bench_stdin`/`bench_session_kill`
  (`src-tauri/src/bench.rs`), which dial the app's own `/ws` endpoint the same
  way `WsTerminalTransport` does — `/ws` is the one PTY transport,
  `terminal_write`/`terminal_destroy` no longer exist. The results JSON's
  `m9.wsGap` (`gaps`, `reattaches`) reads `ws.ts`'s own `__trWsGapStats__`
  counter, replacing the deleted Tauri sink's drop counters as the gap/
  recovery reading.
- **450 ms p95 regression floor**, compared against a recorded baseline
  (243 ms p95 median, 68 ms p50 median). Re-measured on an idle box after the
  transport moved to `/ws`: pooled-p95 median 71 ms, worst frame 84–122 ms,
  dropped frames per 1 000 median 326, flood drain 4.10 s (down from
  11.0–19.0 s pre-transport), app RSS 180 MiB, zero gaps and zero reattaches
  across five valid runs — the ceiling holds; the heavier per-frame profile is
  the transport delivering bytes faster than the renderer paints them, not a
  regression.
- **5 runs + median**, never one: a single run samples only ~40–80 frames, so
  one hitch can move its p95 by hundreds of ms.
- Refuses `--channel release`; defaults to a **throwaway channel `m9bench`**
  (`~/.houston-m9bench`), wiped before every run — and only ever wipes
  that literal channel name, never `dev`/`release`/an explicit other. The
  wipe itself refuses if a live daemon holds `daemon.lock` on that state dir.
- Aborts (exit 2) rather than reporting a number if the grid wasn't clean
  (`preExistingPanes != 0`) — comparing a dirty-grid run to the 12-pane
  baseline would be meaningless.

### `scripts/boot-baseline.sh`

The boot budget's evidence — how long until the window is there, and how
long until you can type into it:

```
./scripts/boot-baseline.sh        # RUNS=5 by default
```

- Same requirements and same throwaway-channel rules as `m9-baseline.sh`
  above: a release binary built with `--features bench`, `m9bench` by default,
  `release` refused, and only ever wipes that one literal channel name.
- Runs `--bench=M10` against **two channel states**, because they answer
  different questions. **COLD** is a wiped channel: no session to restore, so
  it measures process start → daemon → window → page load → `<App/>` mounted.
  **WARM** is the same channel after one `--bench=M11` has seeded 12 shell
  sessions into it, which is the boot a returning user actually gets and the
  only one that can report a typeable time.
- The two headline stamps exist only on a warm boot: **`grid-painted`** (the
  first pane element is in the DOM) and **`focused-pane-typeable`** (that
  pane's engine is live and its stdin is open — the first instant a keystroke
  would reach the PTY). `TerminalPane` publishes the latter as `data-typeable`;
  it is deliberately *not* "the skeleton is gone", which waits on the
  scrollback replay long after keys already work.
- Reports **per-phase deltas**, not one total: boot cost is only actionable
  per phase, and a total hides which phase moved.
- **5 runs + median** per condition. Voids any run that hit a phase deadline —
  the stamp such a run reports is the deadline, not the event. Aborts (exit 2)
  if a cold run found sessions, a warm run found none, or the restored-session
  count moved between warm runs; in each case the runs are not comparable.
- **Budgets**: cold start to `<App/>` mounted, 0 sessions, **< 3 s** (measured
  median 2.14 s); warm restore to `focused-pane-typeable`, 12 panes, **< 3.5 s**
  (measured median 2.30 s). Both are 3-run medians on an idle machine;
  ceilings are ~1.5× the measured median.
- Unlike M9 it does not sample rAF timings, but its own `waitForDom` deadline
  enforcement used to re-check only from a `MutationObserver` callback and an
  rAF tick loop — on an unfocused WebKitGTK window rAF throttles to near
  zero, so once the grid finished mounting with no further DOM mutation to
  wake the observer, the wait never re-checked its own deadline and hung
  past the harness's process-level watchdog instead of timing out at
  `BOOT_PHASE_DEADLINE_MS`. `waitForDom` now also polls on a `setInterval`,
  which fires regardless of focus. It is still wall-clock: an idle machine
  still matters.

## Desktop artifacts per OS

### Linux

```
./scripts/build-app.sh          # renderer + gate + appimage,deb
./scripts/build-app.sh --bundles deb    # same, different bundle targets
```

It re-execs itself under `scripts/oom-shield.sh` (`-j 3`) unless already
shielded, builds the renderer (unless `--skip-renderer`), runs
`check-renderer-fresh.sh` unconditionally, then builds and stages `tr-helper`,
`houston-core` and `houston-supervisor` under `src-tauri/binaries` with the
host target triple. It then runs `CARGO_BUILD_JOBS=3 cargo tauri build --bundles
<targets>`. Output lands at
`src-tauri/target/release/bundle/{appimage,deb}/*.{AppImage,deb}`.

Use `build-app.sh` rather than invoking `cargo tauri build` directly; it
prepares the renderer and all Linux sidecars that the bundle requires.

Local install, separate from packaging:

```
./scripts/install-desktop.sh
```

Refuses on a missing icon SVG or `convert` (ImageMagick), a missing app
binary, renderer or binary staleness (re-running `check-renderer-fresh.sh`
and `check-binary-fresh.sh`), and — after writing `launch.sh`, `start.sh`, and
the `.desktop` file — a repo-path leak: it greps all three for the repo's own
absolute path and refuses to finish if found, so the installed app can never
execute a path inside the repo. Installs:
`~/.local/lib/houston/{houston, tr-helper, start.sh, launch.sh}`,
`~/.local/share/applications/houston.desktop`, and icon PNGs under
`~/.local/share/icons/hicolor/**/apps/houston.png`.

### Windows

```
./scripts/build-app.ps1
cargo tauri build --bundles nsis      # documented extra step
```

`build-app.ps1` runs the full renderer gate (`typecheck`, `test`, `build`,
`check:css`), the same `check-renderer-fresh.sh` via Git Bash, stages
`tr-helper.exe` and `houston-core.exe` before the app build, then runs
`cargo build --release` and copies `houston-tauri.exe` → `houston.exe`. It
stops short of bundling by design — the NSIS step above is the documented
extra. Output lands at
`src-tauri/target/release/bundle/nsis/*.exe`.

**The Windows installer is unsigned.** No code-signing certificate exists
for this project, so SmartScreen will warn on first run — this is expected,
not a build failure.
