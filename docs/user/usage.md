# Usage

Settings ▸ Usage shows token and cost figures for agent work you've run through Houston.
This page is narrower than the settings label might suggest — read the coverage section
below before trusting a number here as your full spend.

## What it covers

Usage reads transcript files that Claude Code and Codex already write to disk on your
own machine, counts tokens out of them, and folds those counts into hourly buckets by
provider and model. Those two CLIs are the only ones it covers.

## What it does not cover

Every other CLI Houston can spawn and that spends tokens — Antigravity, OpenCode,
Cursor, Grok — is not read by this feature. Houston shows these explicitly as "not
tracked" rather than as zero usage, because a `0` next to one of them would read as "you
spent nothing," which the daemon has no way to actually confirm. Shell, SSH and custom
sessions spend no tokens, so they're outside the feature by nature, not by omission;
Droid, Copilot and Aider are absent because Houston cannot spawn them at all today, so
there's nothing to have spent through Houston in the first place.

## Where the numbers come from

Token counts come only from files under each CLI's own transcript directory (Claude
Code's and Codex's own on-disk session logs) — the same files those CLIs already write
for their own purposes. Houston opens them only while the Usage section is actually open
and you've asked to see it: no background timer, no watcher, no scan at startup. A line
in a transcript becomes a token tally and is then dropped — prompt text, tool output,
file contents and paths inside a transcript are never retained, logged, cached, or sent
anywhere; only integer counts plus a model and session identifier are kept, in a local
cache that exists to make re-opening a transcript file cheap on a later look.

Dollar costs are computed from a public model-rate table (LiteLLM's, the same one the
`ccusage` tool prices against) fetched from GitHub over the network — the only network
call this feature makes — and cached locally afterward. If a model has no entry in that
table, or the provider itself reported an authoritative cost already, the figure is
marked accordingly rather than guessed.

## What it cannot tell you

If a transcript's format has drifted from what Houston expects, the scan yields fewer
records rather than failing outright or guessing a number — so an oddly low count can
mean "you did less" or "we couldn't parse some of it," and there's no way from the
screen alone to tell those apart beyond the per-source counts it reports. It also has no
visibility into anything not covered above: work in an untracked CLI, or any usage of
that CLI outside a Houston-hosted session.
