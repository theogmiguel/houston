# The renderer

> For maintainers. Start at [overview.md](overview.md) for the process model.
> Visual rules — colour, type, spacing, component anatomy — live in
> [`styleguide.md`](styleguide.md); this page is structure and mechanism.

## Stack

React 19, Tailwind 4 (`@tailwindcss/vite`), Vite+ (`vp`), TanStack Router, Effect atoms for
server state, Base UI primitives, TipTap for the composer, `lucide-react` for icons and two
`@fontsource-variable` families (Inter, JetBrains Mono). Package manager is **`pnpm`**.

`pnpm dev:desktop` runs the Vite dev server with HMR and launches Electron against it.
A packaged build is a static bundle in `apps/web/dist`, copied into
`apps/server/dist/client` and served by the host over the `houston://app` protocol
(`houston-dev://app` in development builds, which proxy to the dev server).
`scripts/dev.sh` builds that bundle and launches the Electron host; it is the channel-level
equivalent of the installed app.

`apps/web/package.json` scripts: `dev`, `dev:built`, `build`, `preview`, `test` and
`build:ghostty-wasm`. The workspace `typecheck` script covers the package.

## Source tree

```
apps/web/src/
  AppRoot.tsx          the application root; the router renders workspaces and panes
  routes/              TanStack Router route files (`routeTree.gen.ts` is generated)
  components/          the UI: chat/, settings/, files/, device/, desktop/ and the shared ui/ primitives
  layout/              the workspace model, its store and sync, and the panes that render it
  threads/ shortcuts/  thread opening and ordering; keybinding dispatch and commands
  connection/          the connection catalog and the desktop host's bootstraps
  environments/        the primary environment's target, auth and HTTP layer
  rpc/                 the atom registry the server state is read through
  terminal/ghostty/    the terminal engine: vendored WASM → Canvas 2D
  speech/              dictation: capture, consent and the environment's engine
  motion/              the motion roles and the motion probe
  mobile/ onboarding/  the phone layout and first-run flow
  i18n/ observability/ message catalogues; client tracing
  lib/ hooks/ state/   shared helpers, hooks and stores
  index.css            every design token and the Tailwind theme
```

The terminal engine is vendored in-tree — there is no terminal package in `package.json`.

## Transport

The renderer asks `window.hostBridge.getLocalEnvironmentBootstraps()`
(`src/connection/desktopLocal.ts`) for the channel's server origin and bootstrap credential.
`packages/client-runtime` (`connection/resolver.ts`) opens the WebSocket at `/ws` on that
origin with the credential the server issues for it. The token comes only from the host
bridge. The messages are typed in `packages/contracts`; the renderer defines none of its own.

The renderer re-reads the bootstraps and the server status when the host announces a change
(`onLocalEnvironmentBootstrapsChanged`, `onServerStatus`) and on one shared safety poll
(`src/connection/desktopLocalTopology.ts`). A new reader subscribes there instead of starting
its own timer. The host traces these reads only when they fail (`FAILURE_ONLY_TRACED_CHANNELS`
in `apps/desktop/src/ipc/DesktopIpc.ts`), so that they do not fill the trace file.
A registration build that cannot reach a server it was told of retries after 1, 2, 4, 8 and
16 seconds, then leaves it to the safety poll (`PLATFORM_DISCOVERY_RETRY_DELAYS` in
`src/connection/platform.ts`): a browser has no host to announce its server, and a failed
discovery drops the environment until the next read.

## The terminal engine

`terminal/ghostty/` is Houston's own engine; its README lists each file's job. The WASM is
vendored and loaded by Vite URL import (`./vendor/ghostty-vt.wasm?url`,
`./vendor/ghostty-write-pty.wasm?url&no-inline`), so nothing is fetched at runtime, and
`apps/web/scripts/build-libghostty-wasm.sh` regenerates it from the pin in
`native/libghostty-vt`.

`GhosttyRuntime` (`ghostty/runtime.ts`) wraps the exports with a hand-written struct-layout
system and caches a `DataView`/`Uint8Array` over WASM memory — the alternative was tens of
thousands of per-frame allocations. The cache is refreshed on buffer identity change,
because growing a `WebAssembly.Memory` detaches the old `ArrayBuffer`.

The render target is **Canvas 2D** — not WebGL, not DOM (`ghostty/renderer.ts`,
`ghostty/surface.ts`). Terminal bytes arrive through the client runtime; the engine holds no
React state in its render loop.

## Layout

The main area is a **workspace**: a strip of columns, each a stack of panes, each pane a bar of
tabs. `apps/web/src/layout/layoutModel.ts` holds the pure model: its functions return the same
object when nothing changes, so a store update that does nothing renders nothing. `layoutStore.ts`
holds the state for the device, across environments, and `LayoutHost` renders the focused
workspace.

The server owns the durable copy (`houston_layout_workspaces`, one row per workspace; every
mutation commits in one transaction and bumps the revision), so an agent's change through the
`houston_workspace_*` tools reaches the open window. `layoutSync.ts` pushes a change after a
settle delay and retries a lost revision race a bounded number of times before it shows the
server's copy; both constants carry their rationale in the code. Layout is never held in the
browser's storage.

A tab's content is a thread's chat, a surface, a launcher or a page. A content has one tab across
all workspaces, so opening an open thread focuses its tab. Surface state stays in the surface
stores (`rightPanelStore`, `terminalUiStateStore`); `surfaceSync.ts` keeps their tabs in step with
the layout when the two have loaded. A thread whose chat is on no tab is listed under the first
workspace and gains a tab when opened.

Columns carry a width as a fraction of the strip. By default a column stays at least
`LAYOUT_READABLE_COLUMN_PX` (420) wide and the strip scrolls when the columns no longer fit; the
workspace records the strip width it was arranged at (`cameraWidth`) so a long strip does not
reflow when the window resizes. In that default the strip is never shorter than the window: a
column held at the readable width takes its room from the others when a column opens, and a
column narrowed by its divider hands the room to the next one. The user can choose to always
shrink or always scroll instead.
Panes are positioned from the model's geometry (`paneGeometry.ts`).

Every bound (columns, panes per column, tabs per pane and per workspace, name and id length) is in
`HOUSTON_LAYOUT_WORKSPACE_LIMITS`; a refusal names the limit, the actual value and the
operation.

## Desktop bridge

The renderer reaches the host through `HostBridge`, exposed by the Electron preload
(`apps/desktop/src/preload.ts`) and typed in `packages/contracts` (`ipc.ts`). Its members group
window chrome, notifications and the badge, the quick composer, settings and the connection
catalog, SSH, WSL, snapshots, updates, the v1 cleanup report and the browser-preview bridge.

## Renderer recovery

The main process listens for the window's `render-process-gone`. A crash, OOM, kill or
abnormal exit reloads the window after a delay that doubles with each consecutive crash, from
500 ms up to a 30-second ceiling, so a renderer that keeps crashing is retried without a tight
loop and the window is never left blank for good. A reloaded renderer that stays up for sixty
seconds restarts the backoff (`apps/desktop/src/window/RendererRecovery.ts`). A clean exit or a
closed or destroyed window is not reloaded. While a quit or update install is in progress the
pending reload waits, so it never fights the quit and still runs if the install fails; only one
reload is pending at a time. Development retries a failed load from the dev server with
increasing delays while the page is being served.

## What the renderer knows

Only what it is handed. Origin and token come from the host bridge. Build-time values arrive
through `import.meta.env` (`VITE_*` and `APP_VERSION`); nothing under `apps/web/src` reads
`process.env`.

## Notifications

The renderer detects thread status transitions, checks the window's focus state and calls
`HostBridge.notifyThread` with a stable thread key, a title and a bounded body. The host shows
the OS notification (`apps/desktop/src/notifications/DesktopNotifications.ts`); a click returns
the key through `onThreadNotificationFocus`. `notificationsSupported` reports a refusal with its
reason, such as a Linux machine with no notification service. The badge count goes through
`setNotificationBadge`.

## Microphone capture

Dictation records through `navigator.mediaDevices.getUserMedia({ audio: true })`
in the Electron renderer. The host serves the app from a secure custom protocol, so the page
has `navigator.mediaDevices`; microphone permission follows Chromium's and the OS's rules for
the app. A denied microphone reaches the renderer as the same recording start error as a
browser denial.

Audio is transcribed by the server, not the webview, and the native engine runs in a separate
process: `apps/server/src/speech/native.ts` starts the packaged executable with the hidden
`__speech-worker` command. The packaged server is a Node single executable, where `import()`
cannot load a module from the file system, so `nativeWorker.ts` loads the engine through
`createRequire` while development and tests keep the ESM loader.

The audio destination is a per-device grant in local storage (`houston:voice-audio-grant:v1`),
separate from synced settings so a stale settings write cannot restore it. Each choice gets a
fresh grant id; a recording is bound to the id it started with and is discarded when the grant
changes. Cleanup consent uses its own key for the same reason. Dictation preferences are client
settings sent with each recording, so one environment can transcribe for any client; only the
project dictionary, model, acceleration and unload policy live on the environment. Clients
refuse an environment whose `voiceProtocol` is not the version they speak instead of sending
it a payload it cannot decode.

The desktop browser's annotation editor runs in the guest page, but recording stays in the app
renderer: the pick preload relays trusted key events and draft edits over IPC tagged with a
per-pick session id, and the renderer pushes recording state back. Events and state for another
session are dropped on both sides.

## Testing

`pnpm --filter @houston-app/web test` runs the `unit` and `browser` projects from
`apps/web/vite.config.ts`; the config also defines a render-scenario project over
`test/*.renders.tsx`. See [testing.md](testing.md) for the discriminators. Browser tests
run in Chromium through Playwright. Shared fixtures live in `apps/web/test/`.

Legibility is held by unit tests over the theme palettes (`appearanceContrast.test.ts`,
`themePalette.test.ts`) and by the style guards in [style-guard.md](style-guard.md).
