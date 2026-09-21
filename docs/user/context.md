# Context

A static ring in each supported agent pane's header shows how full its model context is, so
you do not have to run `/context` inside the terminal to find out. Hover, click or focus the ring for
the percentage used and token count against the limit. A short status appears while a
response is in progress, after compaction or near the limit.

## What it reads

For a supported session, the ring fills clockwise as context use grows. Its detail reads, for
example:

```
Context · 6% used
12.3k / 200k tokens
```

- The used figure is the latest context snapshot, including input, cache and output tokens.
  It is not the cumulative usage across the conversation.
- A context limit reported by the CLI takes priority. Codex reports this value today.
  Otherwise Houston uses the model catalog's native input context size. A session-specific
  override that is not present in the transcript or model id cannot be detected.
- The ring keeps the last completed reading while the agent works. It changes to warning and
  danger colours as the context approaches its limit.
- After compaction, it uses the new count when the agent reports it.

## Coverage

Claude and Codex are supported through their lifecycle hooks. Enable Codex hooks in
Settings ▸ Agent setup if they are not already enabled. Cursor, Grok, OpenCode and Antigravity
show no ring because Houston has no context signal for them. A model with an unknown limit
shows its token count without a percentage. Model changes appear after the next completed
response. Refreshed catalog metadata also appears after the next completed response; refreshing
rates does not recompute the reading already shown for a pane.

## Where the numbers come from

Houston reads the transcript file the agent already writes on your machine, using the path
the CLI reports through the hook Houston installs. Only integer token counts, the model id and
the session id are kept; prompt text, tool output and file contents are never retained, logged
or sent anywhere. The value is not persisted and resets when the session respawns.

Houston uses LiteLLM's public model catalog for context limits and Usage pricing. It keeps
one local copy and checks for changes at daemon startup and every six hours. Installed-agent
checks and Usage requests can also refresh a copy older than six hours. Requests contain no conversation data,
model selection or session identifiers. Concurrent requests share one download; a failed or
invalid download retains the last valid copy. Context lookups use the in-memory copy and never
perform network work from a lifecycle hook.

Settings ▸ About ▸ **Check for updates** controls automatic catalog requests. Disabling it
keeps the existing local copy available; the explicit **Refresh rates** action in Usage still
requests a refresh. A small catalog of context limits from official provider specifications is
bundled for first-run offline use. It contains no pricing data. Catalog data only describes
models: it does not install models, add providers Houston can spawn or change a CLI's model
configuration.

## Turning it off

Settings ▸ Appearance ▸ **Show context indicator** hides every pane's ring. It is on by default.
