# Orchestration

Orchestration lets an agent running in a Houston pane open new panes of its own, brief
them, and wait for what they report back. A parent pane becomes an orchestrator; the
panes it opens are its children. A child can itself become an orchestrator, up to a
depth limit you control.

## Turning it on

Orchestration is off by default. Turn it on in Settings ▸ Orchestration ▸ Enable
orchestration. Until you do, an agent in a pane has no way to spawn another pane — the
tools for it are not even offered to it.

## The two surfaces an agent uses

An agent drives orchestration through either of two doors, which always agree with each
other on names and arguments:

- An MCP tool set: `pane_spawn`, `pane_list`, `pane_get`, `pane_send_keys`, `pane_read`,
  `pane_prompt`, `pane_wait`, `pane_kill`, `pane_submit`.
- A command-line tool, `hs-pane`, with one subcommand per verb above (plus a CLI-only
  `whoami`) — for an agent CLI that has no MCP tool support of its own.

Which tools a given pane actually sees depends on what it is: a pane with no parent and
no orchestration ability sees none of them; an orchestrator sees the management verbs
and `pane_spawn` for as long as it has spawn budget left; a spawned child sees only
`pane_submit` (its handback) and its own identity check — nothing else from this set is
useful to it, so it is not offered.

## The caps, and what happens when one trips

Two caps bound how far a tree of agents can grow, both editable in Settings ▸
Orchestration:

- **Max child panes per agent** — how many panes one agent may have live at once.
  Defaults to 4. A spawn attempt past the cap is refused with a message naming the
  pane, how many live children it already has, and the cap: `spawn refused: pane
  <id> already has <n> live children (cap <n>)`.
- **Max nesting depth** — how many generations deep a spawn chain may go. Defaults to
  1: a pane you opened may spawn a child, but that child does not itself spawn.
  A spawn attempt that would sit past the cap is refused naming the depth it would
  land at and the cap, with an explanation that nesting is off by default because the
  cost of a tree compounds per generation, and a pointer to raise the cap in Settings ▸
  Orchestration if a longer chain is what you meant.

Both caps can be raised (up to a fixed ceiling in Settings), never bypassed by an agent
itself.

A related but separate rule: a spawned child never gets a wider permission bypass than
its parent holds. If a parent tries to spawn a child at the full approval bypass while
the parent itself is not at that bypass, the spawn is refused — a pane cannot hand a
child a permission it does not itself have.

## Getting a result back

A child reports back to its parent by calling `pane_submit` — its handback point, and
the only way it ends its side of the delegation. The parent either polls for it with
`pane_wait`, which blocks until a result (or a question, or an exit) is ready, or
notices it because the child's completion reaches the parent's own next wait. There is
no separate "check on it" step: the result lands in the parent's inbox and is picked up
the next time the parent asks.

## Mailbox retention

**Mailbox retention** (Settings ▸ Orchestration) controls how long a delivered mailbox
file survives before Houston sweeps it. It only moves the cleanup horizon — it never
changes whether a message is delivered.

## Staying in the loop as the human

Orchestration does not lock you out of a pane an agent opened. Any pane in the grid,
including one spawned by another agent, is a real terminal you can click into and read,
and you can type into it directly at any time — the same as any pane you opened
yourself. Delegation changes who briefed the pane, not who is allowed to use it.
