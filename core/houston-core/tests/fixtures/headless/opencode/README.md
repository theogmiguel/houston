# OpenCode ACP fixtures

These hand-authored fixtures exercise Houston's Agent Client Protocol parser for
OpenCode. They have not yet been verified against a captured `opencode acp` session.

## Sources

- The Agent Client Protocol schema for `initialize`, session lifecycle, prompts,
  permission requests and session updates.
- The command shapes reported by `opencode --help` and `opencode acp --help`.
- Houston's supported session-update variants in `core/houston-core/src/acp.rs`.

Replace these fixtures with a captured, redacted session when one is available.

## Files

- `no_permission.ndjson` — a new session with one response and no tool call.
- `permission.ndjson` — a new session with a tool permission request.
- `resume.ndjson` — a `session/load` request for an existing session identifier.
