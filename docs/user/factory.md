# Factory

The **Factory** page arranges task work from every workspace by what needs you. Choose
**Factory** at the top of the rail, above the workspaces. The Tasks page and the grid stay
as they are; Factory reads the same tasks and panes.

## Needs you

The first section lists what waits on you, oldest first: an agent's question with options,
a run waiting for input in its pane and a task handed back for review. **Next** moves to the
first item.

- A question with options shows one button per option and marks the one the agent
  recommends. Choosing an option answers it; Houston types the answer into the agent's
  pane once the agent is idle. **Open pane** answers in your own words.
- A run waiting for input shows what the agent asked, when Houston received it, and
  **Open pane**. These prompts belong to the agent's terminal, so they are answered there.
- A task in review offers **Review**, which opens the task with its proof of done, and its
  pull request when one is recorded.

Plans waiting for approval stay on the Tasks page.

## Working

One row per live task run in every workspace: the task, the agent and model, the branch or
worktree, what the agent reports it is doing and how long the run has been going.
**Open pane** focuses its terminal.

## Sources

**Slack requests** lists requests waiting for the owner or for a slot, with the same chips as
the Tasks page. **Ready backlog** lists todo tasks without a run. **Start in worktree** starts
one task with its workspace's default agent; select several and choose **Start selected** to
start each of them. Starting here never bypasses readiness: a task that is not ready is
refused with the reason, and **Start anyway** remains on the task itself. Tasks imported from
GitHub Issues or Notion appear in the backlog like any other task.

## Landing

Tasks in review, and tasks done in the last seven days, that recorded a pull request. The
number opens the pull request in Houston when the app already follows it, otherwise on the
forge, with its state and checks when known. Merge from the pull request view; a merged pull
request moves its task to **Done**.

## Limits

The page shows **Live runs** and **Needs you** against their limits. Set both in
Settings ▸ Tasks ▸ Factory; each shows its current value.

- **Live task runs** (default 3, at most 16) counts implementation runs in every
  workspace. A Start, Resume or Retry beyond it is refused with the limit and the live count.
- **Needs-you items before automatic starts pause** (default 3, at most 16) counts tasks in
  review, runs waiting for input and unanswered agent questions. At that number, automatic
  starts wait: accepted Slack requests and adjustments, an orchestrator's queue and
  `task_execute`, and automatic rework. Answer or review to let them continue.

Slack's limit of two working requests applies within these limits.

## What leaves the machine

The Factory page sends nothing of its own. Answers go to the agent's pane, and starts are
the same as a Start on the Tasks page; see [Tasks](tasks.md) and [Slack requests](slack.md).
