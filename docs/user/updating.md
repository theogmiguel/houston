# Updating Houston

Houston tells you when a newer release exists, and installs it when you click.

## The check

Settings ▸ About shows which Houston you are running — version, channel and the commit it
was built from — and whether a newer release has been published. Houston checks shortly
after the app starts, every four minutes after that, and whenever you press **Check now**.
The same schedule checks the model catalog used by Usage and the context indicator.
Checks reuse cached responses when the server confirms nothing changed.

The request fetches the public `latest.json` update manifest from the project's GitHub
releases — the same file the in-app updater reads — and asks one question: what is the latest
release. It is not a GitHub API call, so it does not draw on the anonymous API quota shared
by everyone behind your public IP address. It carries nothing about you — not your version,
not your operating system, not any identifier — and nothing comes back except the release's
own public details. A prerelease is ignored: a release candidate is cut as a tag and
installed by hand, never offered as an update.

If GitHub refuses the check because of a rate limit, the panel names the limit, how much of
it was used and when it resets, when GitHub reports them.

**Switching it off.** Settings ▸ About ▸ _Check for updates_. Off means the request is
never made, and the panel says so rather than going quiet. The current value is always on
screen; nothing about this lives only in a file.

This switch also controls automatic requests for the shared public model catalog used by
[Usage](usage.md) and the [context indicator](context.md). Its bundled context fallback and
cached data remain available offline. Usage's explicit **Refresh rates** action still requests
the catalog while automatic checks are off.

When a release is newer than what you are running, the panel names it, shows the start of
its notes and how many sessions are live, and offers **Install update…** beside **Release
notes** and **Later**. The bottom of the sidebar says so too, beside the theme switch: a
chip reading "_version_ available" that opens the same install dialog directly. It shows
"Updating _n_%" while an install runs and "Update failed" if one did not finish. It appears
only while a newer release is waiting, and **Later** puts it away until a release newer
still comes along — the panel itself goes on naming the release either way.

## Installing the update

**Install update…** opens a dialog with the release notes and, when sessions are running,
a choice about them:

- **Keep sessions running** (the default) — the update installs, Houston reopens, and the
  running sessions move to a new daemon on the new build. If the move fails, they stay on
  the current daemon.
- **Stop everything and update** — the dialog lists the sessions that will end. Houston
  stops exactly those sessions, installs, and reopens on a fresh daemon. If the running
  sessions change while the dialog is open, Houston refreshes the list and asks again
  instead of stopping a session you were not shown.

When the daemon cannot move its sessions (a live SSH session, Windows, or no supervisor in
front of the daemon), only the stop option is offered and the dialog shows the daemon's
reason. With no live sessions the dialog is a plain confirmation.

The download's signature is checked against Houston's signing key before anything is
stopped or installed. The dialog then shows each step — download, verify, stop, install,
reopen — and **Hide** closes it while the install continues; the sidebar chip shows the
progress. If anything does not line up — no artifact for this build, a signature that does
not verify, or a manifest that moved on since the offer was shown — nothing is installed
and the dialog says why. If the install fails after the sessions were stopped, Houston
restarts the daemon and the error says how many sessions had already ended.

The install check has a 30-second deadline. Downloads fail after 30 seconds without
network data or 15 minutes overall, allowing another attempt from Settings ▸ About.
A download timeout happens before any sessions are stopped or an installer is started.

## Linux

A `.deb` install runs your package manager's usual privileged install. An AppImage install
replaces the running file in place. Houston relaunches after either install. An AppImage
started without `$APPIMAGE` cannot be relaunched safely, so the update is refused before
download.

During startup, the reopened app moves the running daemon and its sessions to the new
build. If that handoff cannot complete, the current daemon keeps every session: the new
app attaches to it when their protocols match, and otherwise names the reason instead of
attaching. You can also install a downloaded `.deb` or `.AppImage` yourself, exactly as
you did the first time; Houston then attaches to the running daemon as usual.

## Windows

**Install update** downloads the NSIS installer and runs it. The installer uninstalls the
previous version first, and Houston's own uninstall hook stops that old version's daemon
process as part of that step — matched by the process ID recorded for that install, never
by process name, so it can't affect an unrelated Houston install or channel.

Because the installer replaces the daemon binary, sessions cannot be kept running: the
dialog offers only **Stop everything and update** while sessions are live. The Windows installer is
not code-signed, so SmartScreen warns on first run. That is expected.

## What happens to running agents

Houston's daemon — the background process that owns your terminals — outlives the app
window. When the new app finds a daemon from another build, it asks that daemon to hand its
sessions to the daemon binary bundled with the new install. A successful handoff preserves
the sessions while moving the channel to the new build.

If a same-protocol handoff cannot complete, the app can continue against the running daemon
rather than interrupt its sessions. If the protocols differ, the app refuses to attach and
reports why; the old daemon and every session it owns remain unchanged. Finish or close those
sessions, then restart the daemon before opening the new app again.

To replace an idle daemon explicitly, launch Houston with `--daemon-fresh` from a terminal,
not from inside a Houston pane on the channel being restarted. It requests an orderly
shutdown, waits for the daemon to exit, then starts the installed binary; it never stops
live sessions without an explicit confirmation.

## Coming from Houston 1

Houston 2 installs as the same application as Houston 1, so it replaces it without a separate
migration step. Your state continues under `~/.houston`; Houston 2 keeps its own data in
`~/.houston/v2` and never changes Houston 1's files.

On the first start, Houston stops Houston 1's own daemon unit for the channel and removes the
hook and MCP entries Houston 1 added to Claude, Codex, OpenCode, Antigravity and ZCode. The
removal waits while a Houston 1 daemon is still running, since that daemon would reinstall its
entries at startup. Settings ▸ Maintenance shows the outcome and names anything that still needs
you to quit Houston 1.

Houston 1 conversations in the same channel are imported once, automatically. The rest is a
one-time, read-only import in Settings ▸ Maintenance under **Coming from Houston 1**:

- projects (Houston 1 workspaces that still exist on disk), the Tasks backlog and its settings,
  task-source links, and Slack intake.
- Night shift runs and harness reviews are not imported: Houston 2 uses scheduled tasks instead.

The import reads Houston 1's `houston.db` and leaves it untouched. It refuses to copy tasks into
a v2 backlog that already has tasks rather than merging two unrelated numbering schemes. When a
value cannot be carried over, the row names what happened instead — for example a v1 agent with
no Houston 2 driver, or a workspace that no longer exists. A failed import shows the server's
message in the same section.

## From a terminal

`houston --version` prints the same version and commit the About panel shows, plus the wire
protocol number the app speaks. It starts nothing: no window, no daemon.

## Release notes

Each release's page lists what changed, generated from the pull requests that went into
it. The releases page is
[github.com/theogmiguel/houston/releases](https://github.com/theogmiguel/houston/releases).
