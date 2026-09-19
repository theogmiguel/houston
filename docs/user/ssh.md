# SSH

## What this is, and what it isn't

An SSH pane opens a remote shell on another host as a normal pane in your grid — not a
remote workspace. Only that one shell runs on the remote host; the daemon, every other
pane, and the rest of Houston stay on this machine. A workspace is still a local project
directory: SSH gives you a pane that happens to run somewhere else, not a way to point a
whole workspace at a remote machine.

## Connecting

Save a profile with a host, user and authentication method, and Houston can reconnect to
it later. A profile can also carry a default remote directory and a startup command,
which the pane runs right after connecting — the command is never quoted or altered, so
whatever you save is exactly what runs.

Authentication supports:

- your local SSH agent,
- a specific identity (private key) file, with its passphrase optionally saved,
- a saved password,
- or, for a host read from your `~/.ssh/config`, the identity that file already names
  for it, falling back to your agent if it doesn't name one.

The first time you connect to a host, Houston shows you its key fingerprint to accept —
trust-on-first-use, recorded in a known_hosts file of its own. If the host's key ever
changes afterward, you're shown the new fingerprint next to the one you trusted before,
so you can tell a legitimate rekey from something worth walking away from.

## What doesn't work over SSH

Shell integration is a deliberate non-goal for SSH panes: Houston does not install its
shell-prompt marker across the SSH hop, so the working-directory and command tracking
that plain local shell panes get do not apply to a remote shell. Everything else about
the pane — scrollback, resizing, closing — works the same as a local terminal pane.

You can also send a local file up to the connected host from the pane, streamed rather
than held in memory, which is the one other operation an SSH pane supports beyond a
shell.

There is no auto-reconnect: if the connection drops, you reconnect the pane yourself.
