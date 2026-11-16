# Security Policy

## Reporting a vulnerability

Report it privately, through GitHub's security advisories, never a public issue:

**https://github.com/theogmiguel/houston/security/advisories/new**

## Supported versions

Only the latest `0.x` release is supported. There is no stability promise before 1.0 —
each release carries fixes and behaviour forward, and an older release does not get a
backported patch.

## Scope

Houston is a local, single-user app with no Houston account or hosted control plane. The
server listens on loopback unless **Network access** is turned on, and remote access serves
only devices the user paired. Network-backed features are explicit, including hosted agent
CLIs, GitHub operations, browser and MCP integrations, model downloads and optional cloud
dictation. The security-sensitive surfaces include:

- **The thread-scoped MCP credential** — the credential that scopes what a thread's agent
  can address over Houston's own MCP endpoint. A read-only thread gets no more than the
  operations it must submit.
- **The browser panel's consent model** — the browser panel your agents can drive, and how it
  asks for confirmation before a destructive act.
- **The secret store** — where Houston stores secrets, one 0600 file each in a 0700
  directory, and never in the database or the log.
- **Network-backed features** — particularly browser automation, MCP servers and cloud
  dictation, which can transmit user-selected content to external services.
- **Remote access** — the opt-in listener for paired devices: pairing codes, per-device
  sessions, the Host and Origin checks, and the optional Tailscale HTTPS address. A way to
  obtain a paired device's access without pairing is in scope.
- **Writes into another CLI's own config** — the managed-marker blocks Houston installs
  into an agent CLI's hooks or MCP configuration.

Out of scope: anything requiring physical access to an already-compromised machine, and
issues in the agent CLIs Houston hosts rather than in Houston itself — report those to the
CLI's own maintainer.

## What to expect

Houston's maintainers review vulnerability reports privately. Expect an acknowledgement
within a few days and a fix timeline once the report is understood. There is no bounty
program.
