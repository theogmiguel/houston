# Context

A strip along the bottom of the window shows how full the focused pane's model context is,
so you do not have to run `/context` inside the terminal to find out.

## What it reads

For the focused Claude session:

```
Context   12.3k / 200k   6%   ▓░░░░░░░░░
```

- The used figure is the input side of the most recent turn: the prompt, including the cached
  part. Output tokens are not counted, matching what a re-send occupies.
- The window and the percentage come from the model's documented context size. Hover the
  figure for the exact definition, the cache split, and where the window came from.
- The strip can read `working`, `near limit`, `after compact`, or an `as of` age when the
  session is idle.
- Right after a compaction it shows the post-compaction count, not the pre-compaction one.

## Coverage

Only Claude is read. Every other agent Houston can spawn — Codex, Cursor, Grok, OpenCode,
Antigravity — reads **not tracked**, because Houston has no reported signal for them. It never
estimates a number for an agent it cannot read.

## Where the numbers come from

Houston reads the transcript file Claude Code already writes on your machine, using the path
the CLI reports through the hook Houston installs. Only integer token counts, the model id and
the session id are kept; prompt text, tool output and file contents are never retained, logged
or sent anywhere. The value is not persisted and resets when the session respawns.

## Turning it off

Settings ▸ Appearance ▸ **Show context bar** hides the strip and reclaims its row. It is on by
default.
