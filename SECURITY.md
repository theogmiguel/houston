# Security Policy

## Reporting a vulnerability

Report it privately, through GitHub's security advisories, never a public issue:

**https://github.com/theogmiguel/houston/security/advisories/new**

## Supported versions

Only the latest `0.x` release is supported. There is no stability promise before 1.0 —
each release carries fixes and behaviour forward, and an older release does not get a
backported patch.

## Scope

Houston is a local, single-user app with a loopback-only daemon and no Houston account or
hosted control plane. Network-backed features are explicit, including hosted agent CLIs,
GitHub operations, browser and MCP integrations, model downloads and optional cloud
dictation. The security-sensitive surfaces include:

- **The per-pane MCP credential** — the bearer token that scopes what a pane's agent can
  address over Houston's own MCP endpoint.
- **The browser pane's consent model** — the native browser pane your agents can drive,
  and how it confirms a destructive act before it happens.
- **The OS keychain** — where Houston stores secrets, and never in the database or the log.
- **Network-backed features** — particularly browser automation, MCP servers and cloud
  dictation, which can transmit user-selected content to external services.
- **Writes into another CLI's own config** — the managed-marker blocks Houston installs
  into an agent CLI's hooks or MCP configuration.

Out of scope: anything requiring physical access to an already-compromised machine, and
issues in the agent CLIs Houston hosts rather than in Houston itself — report those to the
CLI's own maintainer.

## What to expect

Houston has a single maintainer. Expect an acknowledgement within a few days and a fix
timeline once the report is understood — there is no bounty program.
