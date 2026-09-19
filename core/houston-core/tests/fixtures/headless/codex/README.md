# Codex headless fixtures

These fixtures exercise Houston's parser for the newline-delimited JSON emitted by
`codex exec --json`. They target Codex CLI 0.144.5 and are not yet verified against a
complete model turn.

## Verification status

The following events were observed directly from `codex exec --json` and
`codex exec resume <id> --json`:

- `thread.started` with `thread_id`
- `turn.started`
- `item.completed` with an error item

The command-execution, agent-message and usage events follow the documented Codex exec
event schema. Replace these fixtures with a captured, redacted run when one is available,
then remove the qualification above.

## Files

- `run_command.ndjson` — a turn that executes a shell command before responding.
- `text_only.ndjson` — a turn that responds without a tool call.
- `resume.ndjson` — a turn that continues an existing thread.
