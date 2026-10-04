# Usage

The Usage page shows token totals and estimated costs for transcripts Houston can read. Open it from the rail or press **Ctrl+U** (**⌘+U** on macOS).
Use the workspace, metric and time range controls in the page header to change the totals. The activity calendar keeps daily totals for up to 365 days, including days whose source transcripts have since been removed. Selecting a day filters the breakdown when detailed records are available.

## What it covers

Usage reads transcript files that Claude Code and Codex already write to disk on your
own machine, counts tokens out of them, and folds those counts into hourly buckets by
provider and model. Those two CLIs are the only ones it covers.

The workspace filter attributes a transcript by its recorded working directory.
A session in a workspace directory or one of its worktrees belongs to that
workspace; sessions outside registered workspaces remain in **All workspaces**.

## What it does not cover

Every other CLI Houston can spawn and that spends tokens — Antigravity, OpenCode,
Cursor, Grok and ZCode — is not read by this feature and is not included in the totals. Shell,
SSH and custom sessions spend no tokens, so they're outside the feature by nature, not
by omission. Droid, Copilot and Aider are absent because Houston cannot spawn them.

## Where the numbers come from

Token counts come only from files under each CLI's own transcript directory (Claude
Code's and Codex's own on-disk session logs) — the same files those CLIs already write
for their own purposes. Houston opens them only while the Usage page is actually open
and you've asked to see it: no background timer, no watcher, no scan at startup. A line
in a transcript becomes a token tally and is then dropped — prompt text, tool output,
file contents and paths inside a transcript are never retained, logged, cached, or sent
anywhere; only integer counts plus a model and session identifier are kept, in a local
cache that exists to make re-opening a transcript file cheap on a later look.

Each scan also adds daily totals to Houston's local SQLite database. The activity
calendar can keep a day after Claude Code or Codex removes its transcript. History
begins when a scan first records that day; older days cannot be reconstructed from
transcripts that have already been deleted. The calendar request returns no more than
365 local calendar days. The scan cache stores the workspace association and speed
tier, but does not retain the transcript working directory.

Dollar costs are computed from LiteLLM's public model catalog, fetched from GitHub and
cached locally. The same cached catalog supplies model context limits to the context
indicator. Houston checks it at startup and every six hours while the daemon is running.
Installed-agent checks and Usage requests also refresh a cache older than six hours. Automatic
requests follow Settings ▸ About ▸ **Check for updates**. **Refresh rates** explicitly requests a fresh copy even when that
setting is off. Concurrent requests share one download, and a failed or invalid download
keeps the last valid copy. When the server confirms the catalog is unchanged, Houston reuses
the cached data without downloading the document again.

If a model has no complete pricing entry, or the provider itself reported an authoritative
cost already, the figure is marked accordingly rather than guessed. The small catalog
bundled for first-run offline context limits contains no fallback prices.

## What it cannot tell you

If a transcript's format has drifted from what Houston expects, the scan may yield fewer
records rather than failing outright or guessing a number. The page does not show
per-source scan diagnostics, so it cannot distinguish reduced usage from records that
could not be parsed. It also has no visibility into work in an unsupported CLI or usage
outside a Houston-hosted session.
