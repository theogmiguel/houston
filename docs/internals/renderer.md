# The renderer

> For maintainers. Start at [overview.md](overview.md) for the process model.
> Visual rules — colour, type, spacing, component anatomy — live in
> [`styleguide.md`](styleguide.md); this page is structure and mechanism.

## Stack

React 19, Tailwind 4 (`@tailwindcss/vite`), Vite 6, Vitest 4 with jsdom, CodeMirror 6 for
the editor, `lucide-react` for icons, three `@fontsource` families. Package manager is
**`bun`, never npm**.

There is **no dev script and no HMR**. The renderer is built once by `vite build` into
`ui/out/renderer` and embedded in the Tauri binary; `scripts/dev.sh` re-runs the build
itself. Losing HMR is a recorded deliberate cost of the one-binary shape.

`ui/package.json` scripts: `build`, `typecheck` (`tsc --noEmit` twice — the app and the
p5 harness), `test` (`vitest run`), `check:css`, `check:bundle`.

## Source tree

```
ui/src/renderer/src/
  App.tsx              the application root: workspaces, grids, dispatch of every ServerMsg
  houston/              transport and daemon-facing types
    client.ts          HoustonClient — the control link, frame codecs, every request method
    host.ts            getHostConfig() — port + token from the Tauri command
    transport/         ws.ts, tauri.ts, types.ts — two terminal transports, one interface
    generated/         ts-rs output, committed; PROTOCOL_VERSION.ts and DEFAULTS.ts
    browser*.ts        native browser-pane geometry, focus, picker, confirm
  ghostty/             the terminal engine: vendored WASM → Canvas 2D (14 files)
    vendor/            ghostty-vt.wasm, ghostty-write-pty.wasm
  pane/                TerminalPane.tsx, ghosttyTerminal.ts, writeQueue.ts, input helpers
  layout/              tree.ts (grids, split tree, persistence) + pane-type and context modules
  components/          the UI; LayoutView.tsx, Shell.tsx, nav/, settings/, git/, agents/, files/
  editor/  git/  voice/  Shell/  test/
  theme.ts theme.css   chrome themes, terminal palettes, every design token
  watchdog.ts          Tier 2 of the paint-freeze watchdog
```

747 `.ts`/`.tsx` files, ~146k lines. The terminal engine is vendored in-tree — there is no
terminal package in `package.json`.

## Transport

`HoustonClient.connect()` (`houston/client.ts`) asks the Tauri command `host_config` for
`{ port, token }`, opens `ws://127.0.0.1:<port>/ws` with `binaryType = 'arraybuffer'`, and
sends `{ type: 'hello', token, protocol: PROTOCOL_VERSION }` as its first frame. The token
never comes from `daemon.json`.

Two message shapes on the socket: **text frames are JSON control messages** (`ServerMsg`),
dispatched to the app; **binary frames are PTY bytes**. Frame kind 1 is output
(`u8 kind | u32 session | u64 offset | payload`), kind 2 is stdin
(`u8 kind | u32 session | payload`), kind 3 is a gap notice. Output frames carry the stream
offset of their first byte so a pane can drop bytes a scrollback replay already covered.

Terminal I/O is behind the `TerminalTransport` interface (`transport/types.ts`), implemented
once by `transport/ws.ts`: frames arrive as binary WS frames on the same socket as control,
writes go out as `encodeStdinFrame` bytes, and `attach()` sends `session_attach`, whose
`scrollback` reply carries the replay and the attachment number (`attempt`) the transport
checks against its own count before honouring it. The daemon sends frames only for sessions
this socket asked about, through a bounded per-session queue; a gap frame (kind 3) means that
queue dropped, and the pane answers with one re-attach.

`sendStdin` is the outbound path: `term.onData` → `client.sendStdin` → the transport's
`write`. It is not queued — a keystroke goes straight out.

`PaneWriteQueue` (`pane/writeQueue.ts`) is the **inbound** pipeline, between arriving frames
and the engine's synchronous `term.write`. It owns escape-safe chunking (`findSafeSplit`
never manufactures a cut inside a CSI, OSC/DCS/PM/APC/SOS, a bare two-byte escape, or a
multi-byte UTF-8 codepoint), a single-write-in-flight gate, a stalled-write watchdog, and
visible backpressure drops.

| Constant | Value | Reason |
|---|---|---|
| `DEFAULT_CHUNK_BYTES` | 256 KiB | ~8 ms of blocking parse — half a 60 Hz frame — with a yield between chunks |
| `DEFAULT_MAX_QUEUED_BYTES` | 2 MiB | queue cap |
| `DEFAULT_DROP_TARGET_FRACTION` | 0.75 | evict to 75 % of the cap so an episode is one hole, not per-frame thrash |
| `DEFAULT_BATCH_WINDOW_MS` | 4 | a quarter-frame of write batching; small writes bypass it |
| `BATCH_WINDOW_CLAMP_MS` | 50 | above this the host is treated as clamping timers, and batching latches off |
| `DEFAULT_WATCHDOG_MS` | 10 000 | unwedges a pane whose engine load hung instead of rejecting |
| `RESYNC_WINDOW_BYTES` | 8 KiB | resync scan after a drop — the same window the daemon's safe-cut uses |
| `DEFAULT_NOTICE_INTERVAL_MS` | 2 000 | how often a loss may narrate itself; the cumulative total rides every notice |

## The terminal engine

`ghostty/` is Houston's own engine. The WASM is vendored and loaded by Vite URL import
(`./vendor/ghostty-vt.wasm?url`, `./vendor/ghostty-write-pty.wasm?url&no-inline`), so
nothing is fetched at runtime.

`GhosttyRuntime` (`ghostty/runtime.ts`) wraps the exports with a hand-written struct-layout
system and caches a `DataView`/`Uint8Array` over WASM memory — the alternative was tens of
thousands of per-frame allocations. The cache is refreshed on buffer identity change,
because growing a `WebAssembly.Memory` detaches the old `ArrayBuffer`.

The render target is **Canvas 2D** — not WebGL, not DOM (`ghostty/renderer.ts`,
`ghostty/surface.ts`). `pane/ghosttyTerminal.ts` is the pane-facing wrapper.

Terminal palettes are applied **to the engine, not to CSS**: `theme.ts` holds
`TERMINAL_PALETTES`, and `ghosttyThemeFromCss` converts a palette's hex values to the
engine's RGB theme. `[data-theme]` scopes app chrome only; it never reaches the terminal
canvas. An unparseable colour degrades to white rather than throwing.

## Layout

`layout/tree.ts` owns the split tree, and it is **entirely client-side** — no part of it
exists in the protocol or the database.

Node union: `LeafNode { kind:'leaf', session, id }`, `BrowserNode`, `EditorNode`,
`GitNode`, plus split and stack containers (`GridSlot = PaneNode | StackNode`).

`LeafNode.id` is a **durable pane identity**, minted once and persisted with the layout,
distinct from the session occupying it. Respawn mints a fresh session id, so a pane
identified by its session would lose identity every time it came back.

Grid metadata is `GridMeta { id, name, named? }`; the tree is stored separately. `named`
records that a grid was auto-named from its first session or renamed by the user;
`isAutoNameable` treats a record predating the field as unnamed only when its persisted
name still matches `/^Grid \d+$/`.

| `localStorage` key | Holds |
|---|---|
| `tr-grids:<workspacePath>` | that workspace's `GridMeta[]` |
| `tr-layout:<workspacePath>::<gridId>` | that grid's `LayoutState { tree, cols }` |
| `tr-theme`, `tr-chrome-theme` | terminal palette and chrome theme |

`DEFAULT_GRID_ID` is the fixed string `g-default` and is never minted, so migration is
deterministic — a second read or a second window cannot mint a different "default" and
orphan the first one's layout. Migration moves a bare `tr-layout:<path>` value under
`::g-default` and registers one grid; once `tr-grids:<path>` exists it never runs again.
`loadLayout` clamps `cols` to 1..4 and returns `{ tree: null, cols: 2 }` on a corrupt
entry rather than crashing the workspace. Removing a workspace cleans both keys.

Layout is therefore per-browser-profile state: never synced, never in the DB, never on the
wire.

`components/LayoutView.tsx` renders it. Panes are absolutely positioned inside one
container — a CSS-grid layout engine was tried and rejected: a React `insertBefore` on
WebKitGTK drops a pane's composited canvas layer, which a grid's own reconciliation triggers
far more often than absolute rects do. Geometry is computed as percentages, then converted to
`calc(<pct>% + <gutter>px)` insets — `GUTTER_PX` 8 at a grid edge, 4 (half) on a shared
interior seam. One function, `paneSlotGeometry`, produces those four declarations, because
the splitter drag's DOM fast path writes them too: writing bare percentages there dropped
the gutter for the length of the gesture and every pane jumped 8px on grab. The drag holds
its state in a ref and writes the DOM directly rather than re-rendering per pointer move;
the keyboard nudge is 4 % of the sibling pair's span. Expand-to-full hides siblings by
`visibility` — it does not unmount them.

### Tab order

There is no designed tab order across regions — no container sets a sequencing
`tabIndex`, and no focus-trap library is used anywhere in the tree. What Tab actually
does is walk plain DOM order:

1. `Sidebar` (rail), when expanded — workspace rows, then their nav-row buttons.
2. The titlebar (`App.tsx`'s `<header>`) — rail toggle (only when the rail is
   collapsed), mode `Segmented`, Tidy, the bell popover, `WindowControls`.
3. `<main>` — exactly one of the pane grid (`LayoutView`), Settings, a rail nav-row
   surface, Agents chat, or the new-session composer. These are alternates in one
   ternary, never siblings, so nothing after this point is reachable in the same
   pass except whichever one is mounted.
4. Inside the grid, panes and their resize splitters follow `layout/tree.ts`'s tree
   order — not a guaranteed reading order (not necessarily top-left to
   bottom-right).

Two widgets implement real roving tabindex (`FilesPane` and `Segmented`) and are
locally well-behaved, but participate in no larger scheme.
`StackTabs` gives every tab in a stack `role="tab"` and its own `tabIndex={0}` without
roving behavior, so a stack with N tabs costs N Tab presses to get through and arrow
keys do nothing there. A terminal pane's real tab stop is a transparent
`<textarea>` (`ghostty/surface.ts`) with no explicit `tabIndex`, so it keeps the
implicit default of `0`.

Escape is centrally chained only while no pane is focused: `App.tsx`'s global
keydown handler closes, in priority order, the bell popover, the shortcut sheet,
Settings, the rail nav-row surface, the new-session composer, the workspace
launcher, then collapses an expanded pane. Once a pane is selected
(`activeId !== null`), that chain is skipped entirely and Escape passes straight
through to the terminal (e.g. for vim/less) — surfaces opened from a selected pane
still close on Escape only because opening them happens to clear `activeId` first,
not because the chain reaches them. Every modal, popover and menu outside that
chain (roughly 30 of them) handles Escape itself, independently, with no shared
priority list.

## Operator inbox

Rows addressed to the operator (`to_session = 0`) are daemon state the bell
reads, never owns. App holds them in a map keyed by row id: `inbox_rows`
replaces one workspace's whole surface, `inbox_changed` replaces one row. The
list is pulled per workspace at `hello_ok` and on every workspace change —
rows outlive the panes involved, so the roster cannot scope them.

The bell renders unresolved rows oldest-first as "Owed to you", above the
time buckets, in the same `--warning` ink as "Needs you". Opening a row sends
`inbox_ack` (delivery, not resolution); `Resolve` sends `inbox_resolve` and is
offered only for `needs_input`, `exited` and `stalled`. "Mark all read" acks
every unread owed row; "Clear all" drops renderer notices and resolves every
owed row, whatever its kind — the bell is an attention surface, and a row the
operator clears is no longer owed. `inbox_changed` is broadcast for every row
write, a pane's rows included, so `applyInboxChanged` keeps only rows with
`to_session = 0` and drops any other. The badge count adds unread owed rows
to unread notices; the `--warning` bell state adds unresolved `needs_input`
owed rows.

"Corrected" is derived client-side from the set's own `corrects` links
(`correctedByMap` in `inboxOwed.ts`): a corrected row's summary is struck
through with a link that scrolls to its correction and holds a fill on it,
and a correction's first line reads `corrects #id`. A provisional row carries
the "may be corrected" marker it shares with the pane card. Jump targets
resolve against the live roster (`original_to`, else `from_session`) and the
button renders only while one of them is still on it.

The sidebar folds unread owed rows into the workspace row's existing attention
pip (`owedByWs` beside `unreadByWs`); the tooltip breaks the number down
("3 unread · 2 owed to you"). No new element.

## The shell

An L-shaped CSS grid:
`grid-template-areas: "rail topbar" "rail grid"`, columns `var(--w-rail) minmax(0, 1fr)`, rows
`var(--h-top) 1fr`. `--w-rail` is the rail's live width, set on the shell root. The rail spans
both rows; the topbar spans the content column. There is no status bar.

Source control shares the main content region with the grid; it is not a leaf in
the persisted split tree. Legacy Changes leaves are removed during layout loading
without discarding the remaining terminals, browser or editor panes. Keeping its
width separate from the split tree lets it close without remounting terminals.

| Region | Metric |
|---|---|
| Rail | resizable, 200–420px, remembered per user; a drag under 160px collapses it, and `sidebarRail` also hides it — there is no icon-only strip |
| Topbar | 44px, two columns, drag region; the mode `Segmented` floats at the window's centre |
| Pane headers | 28px, every pane kind |
| Stack tabs | 26px strip |

## The window background

Two modes. **Solid** paints each theme's own grounds and is the default. **Custom** dithers
one image — a bundled preset or the user's own file — as a single field behind the entire
window: rail, titlebar, gutters, empty states and panes all stand on the same picture. The
pass is Bayer 8×8 ordered dithering in `backdrop/dither.ts`; `backdrop/BackdropMount.tsx`
keeps the whole engine behind a `lazy()` so a Solid launch loads none of it.

### Four grounds, and who wears which

A surface on the field never puts ink straight onto a photograph. Each one wears a flat
**coat** — one per-theme colour at one alpha. In Custom there are exactly **four** grounds;
every element that fills an area is one of them, and nothing else paints a ground:

| Ground | Token | Worn by | Bound |
|---|---|---|---|
| The field | nothing paints | the grid's gutters (`--gutter-bg`) | — |
| Chrome coat | `--custom-chrome-scrim` (`shell`) | rail, titlebar, the corner shoulders, and `--field-plate-bg` under any words on the field | min 60%, proven by `check:css` |
| Panel coat | `--material-base-bg` (`base`) | every screen that fills a content region edge to edge and is Houston's own chrome: Settings, the Skills/Connections/Routines surfaces, the new-session composer, first run | derived, so it inherits the chrome bound |
| Pane coat | `--custom-pane-scrim` | the terminals (on their own canvas), and the Changes/Files/Editor/Skills frames | min 5%, deliberately not gated |

The rule that makes a pane see-through is that **nothing between the field and a pane may
paint**: a pane's transparency is only ever as deep as what it stands on, so the gutters
paint nothing in Custom. A coat on the gutters makes
every pane opaque whatever its own dial says. Which is why the panel coat is worn *only* by
a screen with no pane on it.

The corollary is that ink never stands on the field. A screen with words there (the empty
workspace) wears `--field-plate-bg`, the chrome coat in Custom and transparent in Solid;
a screen that *fills* the region wears the panel coat instead and needs no plate.

The **panel coat is the chrome coat one step heavier** — `min(1, chrome + .12)` on the same
per-theme triple, not a dial of its own, so the panel and the rail move together as the
slider travels instead of drifting apart. At +.12 the panel is a visible
step off the rail wherever the picture is not already the coat's own colour, and 16% of the
picture still reads through it; at +.06 the step disappears and at +.20 so does the picture.
The one place the step cannot exist is a region of the image that already matches the coat
colour — two alphas of one colour over that ground composite to the same pixel, and no
derivation fixes that.

`check:css` records a rung whose Custom fill is transparent as the field and does not hold
ink to a bar over it. No rung is the field as things stand — the gutters are `--gutter-bg`,
which is deliberately not a rung — but the exemption stays for the next rung that goes
transparent.

The **colour** is per-theme (`--custom-chrome-rgb`, `--custom-pane-rgb`, in each theme's
block) and the **strength** is one dial, so `backgroundMode.ts`'s `applyCssVars` projects
`--custom-chrome-alpha` / `--custom-pane-alpha` onto the root element and `theme.css`
composes `rgba(<triple>, <alpha>)`. Their consumers are CSS rules, not components — the
`[data-custom='on']` scope — which is
why the store owns the projection rather than any surface: a dial applied by a component is
a dial some other surface can forget.

The concave corner where a surface meets the rail and the titlebar is not a setting: it is
always cut, in Solid too, wherever a surface fills the region against the rail. Every such
surface (the grid, Settings, Skills, the composer, first run) carries a region class
that draws its own pair of corner squares at that surface's concentric radius. The square is
`--material-shell-bg`, so it is the rail's fill in Solid and the chrome coat in Custom.

**Where the square sits in the stack is the whole difference between the two regions.** On
the grid it paints over the region's ground and under the panes (`--z-base` against
`--z-leaf`): it reaches past the gutter by exactly a pane's radius, and the pane's own
rounded corner leaves the sliver it shows through. On a content region it paints *under* the
screen (`z-index: -1`, inside the wrapper's own stacking context), and the screen rounds its
two left corners to the same `--r-content` — so the arc is **cut out of** the screen's ground
rather than coated over it. Coating was measurably wrong: the wedge came out as the chrome
coat over the panel coat, one step past the rail. Cut, it is the rail exactly — measured at
the worst legal field, graphite rail/wedge 43,43,47 with the panel at 31,31,36, and paper
rail/wedge 224 with the panel at 237.

The grid's own pair is suppressed while a content region is open
(`.grid-region:has(> .content-region)`): the grid's radius is larger, so its square would
show through the screen's cut and double-coat the corner.

The **fade** is a switch: `fadeStop` is where a ramp into the theme's ground *starts*, so
100 (the default) is no fade and 88 blends the last tenth or so.

### Why the canvas carries the pane coat, not the frame

In Custom the TERMINAL's frame stops painting (`--terminal-frame-bg: transparent`) and the
terminal **canvas element** carries the coat instead: `ghostty/renderer.ts`'s
`syncCanvasBackground` writes `rgb(<engine ground> / var(--terminal-coat))`. The engine's
default background is live state a CLI can move at runtime (OSC 11); a coat on the frame
would discard that and paint every terminal the same colour. The loading skeleton wears the
same recipe (`--terminal-skeleton-bg`) so a pane does not flash opaque a frame before the
engine paints.

That transparency is the terminal's alone, and the token split says so. Changes, Files,
Editor and Skills have no canvas — they hold Houston's own ink — so their frames read
`--pane-bg`, which IS the pane coat in Custom. One build had all five on the one transparent
token, which put Houston's labels straight onto the photograph.

The **browser** pane is the one leaf that keeps its opaque ground: a web page is not ours to
see through, and a translucent one would composite whatever the site chose to paint against
the field.

### What is proven, and what is only shown

`check:css` renders two synthetic flat fields per theme at both edges of the dither pass's
luminance band, at the worst legal combination (ceiling at its maximum, chrome coat at its
minimum), and holds every rung's ink to the contrast bar there. Because the band is an
invariant of the pass and blur/tint/coat compositing is monotone, a flat field at the band's
edge brackets every legal image — which is how a build-time gate proves legibility against a
picture it has never seen.

Terminal ink is **not** gated, and cannot be: it is the agent's own ANSI palette, and
repainting it would make the terminal stop being a terminal. Graphite's default palette
grounds on `#000000` — luminance zero — so any translucency raises the denominator and
nothing lowers it again. The pane coat is therefore the one dial with no cap, and the live
preview beside it is what shows the cost. The same goes for the panes that hold Houston's
own ink (Changes, Files, Editor, Skills): they inherit the custom ink cuts from the
`[data-custom='on']` scope, but at the coat's 5% floor the ground *is* the photograph, and no
ink cut clears an arbitrary image. The coat is the dial that buys it back.

## Tauri commands

The renderer reaches the host through ~120 registered commands, grouped: `host`,
`fs` and `fs_allowlist`, `clipboard`, `dialog`, `shell`, `system`, `skills`, `window`,
`tray`, `spike_webview`, `browser`, `watchdog`, plus bench-only commands
behind the `bench` feature.

The invoke handler wraps that list with a security gate: **any command invoked from a
content-only browser webview label is refused** — browser panes hold no app authority.

## The paint-freeze watchdog

Two tiers. Tier 1 is Rust (`src-tauri/src/watchdog/`): a pure transition function
(`machine.rs`), a three-clock classifier (`clocks.rs`, the only file there allowed to read
`SystemTime`), and a liveness probe (`probe.rs`) that is an `eval` round trip whose
*absence* is the signal. Tier 2 is `ui/src/renderer/src/watchdog.ts`.

| Tier 2 constant | Value |
|---|---|
| `T_PAINT_BASE_MS` | 5000 |
| `PAINT_PROBE_GAP_MS` | 5000 — the wait between a RETURNED probe and the next; a MISSED one re-arms at once |
| `T_WARN_MS` | 1500 |
| `DPR_DEBOUNCE_MS` | 250 |
| `POST_WAKE_MIN_MS` / `MAX_MS` | 8000 / 30000 |

**Tier 2 only reports** — `invoke('wd_paint_report', …)`. It never reloads itself; Rust
decides recovery. The success path re-arms through `PAINT_PROBE_GAP_MS` rather than from
inside its own rAF callback, which had it running at the display's refresh rate on an idle
window; Tier 1's own probe drops from `probe_ms` to `probe_hidden_ms` (2 s → 10 s) while the
window is not visible, where escalation is suppressed anyway. Two constraints are enforced externally by `scripts/check-watchdog.sh`:
tauri's `tracing` cargo feature must never be enabled (it makes `eval_script_with_callback`
take a blocking path, letting the supervisor block on the very event loop it watches), and
no file under `src/watchdog/` except `clocks.rs` may read `SystemTime`.

## What the renderer knows

Only what it is handed. It **reads no environment variables at all** — no `import.meta.env`,
no `process.env` anywhere under `ui/src`. Port and token come from `host_config`, the wire
constants come from the generated `PROTOCOL_VERSION.ts` and `DEFAULTS.ts`, and the only
state it keeps for itself is the `localStorage` set above.

## Testing

`vitest run` from `ui/`, always through **`bun run test`** — bare `bun test` runs Bun's own
runner and fails the jsdom tests. `vitest.config.ts` exists purely to stop vitest inheriting
`vite.config.ts` and silently narrowing the collection root; it adds no plugins, no
environment and no setup files. Environment is per file, via a
`// @vitest-environment jsdom` docblock, with Testing Library for component tests; shared
fixtures live in `src/renderer/src/test/`.

`check:css` runs **after** `build` and loads the *emitted* stylesheet in a real browser,
because `@theme`/`@layer` resolution only exists post-build. It re-derives the theme list
and token mapping from source, asserts every `--color-*` token re-resolves per
`[data-theme]` scope, and gates contrast: ink-on-ground at ≥ 4.5:1 per theme and the focus
ring at ≥ 3:1 against two surfaces.
