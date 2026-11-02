# Updating Houston

Houston tells you when a newer release exists, and installs it when you click.

## The check

Settings ▸ About shows which Houston you are running — version, channel and the commit it
was built from — and whether a newer release has been published. Houston asks once when the
daemon starts, every six hours after that, and whenever you press **Check now**.
The same schedule checks the model catalog used by Usage and the context indicator.
Checks reuse cached responses when the server confirms nothing changed.

The request fetches the public `latest.json` update manifest from the project's GitHub
releases — the same file the in-app updater reads — and asks one question: what is the latest
release. It is not a GitHub API call, so it does not draw on the anonymous API quota shared
by everyone behind your public IP address. It carries nothing about you — not your version,
not your operating system, not any identifier — and nothing comes back except the release's
own public details. A prerelease is ignored: a release candidate is cut as a tag and
installed by hand, never offered as an update.

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
If GitHub refuses the check because of a rate limit, the panel names the limit, how much of
it was used and when it resets, when GitHub reports them.
=======
Each server checks that it can install the release before it restarts. If the
release is not available to a server yet, its update fails, the server keeps
running, and you can retry. The confirmation lists each machine it skips and
why, such as a machine that is offline or needs a manual update. Use
**Settings → Environments** for those.
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

**Switching it off.** Settings ▸ About ▸ *Check for updates*. Off means the request is
never made, and the panel says so rather than going quiet. The current value is always on
screen; nothing about this lives only in a file.

This switch also controls automatic requests for the shared public model catalog used by
[Usage](usage.md) and the [context indicator](context.md). Its bundled context fallback and
cached data remain available offline. Usage's explicit **Refresh rates** action still requests
the catalog while automatic checks are off.

When a release is newer than what you are running, the panel names it, shows the start of
its notes and how many sessions are live, and offers **Install update…** beside **Release
notes** and **Later**. The bottom of the sidebar says so too, beside the theme switch: a
chip reading "*version* available" that opens the same install dialog directly. It shows
"Updating *n*%" while an install runs and "Update failed" if one did not finish. It appears
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

## From a terminal

`houston --version` prints the same version and commit the About panel shows, plus the wire
protocol number the app speaks. It starts nothing: no window, no daemon.

## Release notes

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
Each release's page lists what changed, generated from the pull requests that went into
it. The releases page is
[github.com/theogmiguel/houston/releases](https://github.com/theogmiguel/houston/releases).
=======
## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

### macOS app does not reopen after an Alpha update

Updating an older **T3 Code (Alpha)** installation can replace it with
**T3 Code (Beta)** without reopening the app. Open **T3 Code (Beta)** from
Applications, or run:

```sh
open "/Applications/T3 Code (Beta).app"
```

If an old Dock shortcut no longer opens the app, remove it and add the Beta app
from Applications again.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, T3 Code shows a "T3 Code
could not start" window instead of the app. If a newer version is available,
choose **Update** to install it. If not, the window links to the last version
that started on your computer. Download and install it to go back. Use **Copy
details** to include the error in a bug report.

## Registries and proxies

Each server checks T3 Code releases, and providers installed with npm, through
its own npm, so the checks use npm's configured registry, authentication, and
proxy settings. Providers installed with Homebrew or pnpm check through those
tools.
Configure npm on the server's machine. If that registry cannot be reached, the
release shows as unavailable; T3 Code does not try the public registry instead.
Machines without npm check the public npm registry directly.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, T3 Code refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest T3 Code model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
T3 Code downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
