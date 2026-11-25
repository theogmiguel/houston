# Context

A thread's context use is shown in its **details** card under **Usage** when the provider
reports it: tokens used, the limit and the percentage left. The latest completed reading is
kept while the agent works and is replaced after compaction.

**Settings ▸ Labs ▸ Context window indicator** adds a small meter to the composer. It is
optional and off by default. The meter stays visible while the thread has a context reading
and turns into a warning from 80% of the window used.

## What it reads

The used figure is the provider's latest context snapshot for the run, including input,
cache and output tokens. It is not the cumulative usage across the whole thread.

A context limit reported by the provider takes priority. Otherwise Houston uses the model
catalog's input context size. A session-specific override that the provider does not report
cannot be detected. A model with an unknown limit shows its token count without a
percentage.

## Automatic compaction

For Claude threads, the meter's details say where the thread compacts automatically.
**Settings ▸ Providers ▸ Claude ▸ Auto-compact after**, when set, decides it: Houston passes it
to Claude as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and as `autoCompactWindow`. When it is empty,
Houston reads the window from Claude's own configuration: the variable from a `--settings`
launch argument, then from Claude's settings files, then from the environment; then the
`autoCompactWindow` settings. With auto-compaction off (`DISABLE_COMPACT`,
`DISABLE_AUTO_COMPACT` or `autoCompactEnabled: false` in those places) the details show no
compaction point.

Houston does not read Claude's managed policy settings or the `autoCompactEnabled` switch in
Claude's global configuration file, so a window or an off switch set there is not shown.
Other providers choose their own compaction point and Houston does not show it.

## Coverage

The card appears for providers that report token usage. A provider that reports no context
figure is named by the absence of the row, not shown as zero. Model changes appear after the
next completed response.

## What leaves the machine

The figure comes from the provider's own structured report or from the model catalog.
Houston does not read prompt text or terminal output for it. The catalog request carries no
conversation data, model selection or session identifiers.
