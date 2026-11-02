# Usage

Open **Usage** from the rail or press **Ctrl+U** to see token totals and API-equivalent
costs for Claude Code and Codex transcripts on this machine. Choose a workspace or
**All workspaces**, then a 24-hour, 7-day, 30-day or 90-day window.

Houston reads transcripts when you open the page, change its workspace or window, or
request a refresh. It does not scan them on a background timer. Each result reports
when it was read, how long the scan took and when the model-price catalog was updated.
During a refresh, the previous result remains readable. A failed scan reports an error;
refresh again to retry. Before the first result, Houston reports that it is reading
rather than displaying a zero cost.

## Coverage and sources

Houston reads the transcript directories that Claude Code and Codex already maintain,
including directories configured for their Houston agent profiles. These sessions need
not have been launched by Houston. The page names the directories it checked and
reports empty, missing, incomplete or unreadable sources. A missing directory is not
proof that no sessions ran elsewhere.

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
The workspace filter uses the transcript's recorded working directory. Sessions inside
a registered workspace or one of its worktrees belong to that workspace; other sessions
remain in **All workspaces**. Unsupported agents, including OpenCode, Antigravity,
ZCode and the recognised-only Cursor and Grok, are named as not counted rather than reported as zero usage.
=======
Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.
Text generation (thread titles, commit messages, PR text, branch names and review guides) is not in
the totals for Codex or Claude Code 2.0.63 and newer, because those runs save no session history.
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

Transcript formats can change. Unsupported or malformed records may be omitted even
when the file is readable. Source diagnostics describe scan failures; they cannot prove
that every session or token has been counted.

## What Houston keeps

Transcript lines become token counts and usage metadata, then are dropped. Houston does
not retain, log or send prompt text, tool output, file contents or file references from
those lines. It keeps usage counts with model and session identifiers, reported costs,
speed information and the associated registered workspace in a local scan cache. The
transcript's original working directory is not retained; the cache also identifies the
transcript files it has already read.

Each scan records daily totals in the channel's local SQLite database, allowing history
to survive removal of the source transcripts. Usage's only network request is the
price-catalog download; it carries no transcript data.

## Understanding costs

Costs estimate what the recorded usage would cost at API prices. They are not a bill,
subscription charge or remaining allowance. Houston counts input, output, cache reads
and cache writes, and explains the savings against full input prices. A speed surcharge
is reported only when the required rates are available.

Published prices come from LiteLLM's public model catalog, downloaded from GitHub and
cached locally. Automatic catalog checks follow Settings ▸ About ▸ **Check
for updates**. Refreshing Usage explicitly requests a catalog refresh even when
that setting is off. Failed downloads preserve the last valid catalog. Transcript
contents are not sent with the request.

A provider-reported cost can be used when present. Records without usable prices still
contribute tokens, but are marked **not priced**. If every record is unpriced, the page
reports that costs are unavailable instead of claiming a zero-dollar estimate.

## Daily trends and breakdowns

The daily chart compares Claude Code and Codex. Switch between **Cost** and **Tokens**;
the 24-hour window uses hourly totals. Explore a point to read each agent's value.

The breakdown groups usage by model or day. **Sessions** counts distinct sessions in
the selected window or day; repeated records and hours do not add extra sessions.
A session that uses several models can appear in several model rows, so model counts
are not additive.

The year view retains daily totals for up to 365 local calendar days. Its colour always
represents daily cost, even when the daily chart shows tokens. Select a day to filter
the breakdown without changing its grouping; clear the day filter to return to the
whole window.

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
Days whose transcripts have been removed retain their recorded daily total, but cannot
supply model or session detail. History begins when a scan records a day; Houston cannot
reconstruct usage from transcripts that were deleted before it read them.
=======
## Show only some models

To count only some models, or to leave some out, add `usageModelFilter` to the server's
`settings.json` in its `userdata` directory, such as `~/.t3/userdata/settings.json`:

```json
{
  "usageModelFilter": {
    "include": [{ "provider": "claude", "model": "orbit-1" }, { "model": "orbit-2" }],
    "exclude": [{ "model": "drift-9" }]
  }
}
```

`include` keeps only the listed models and `exclude` leaves the listed models out. `provider` is
one of `claude`, `codex`, `cursor`, `grok`, `opencode`, `antigravity`, `pi`, or `muse`; omit it
to match a model ID from any provider. Use the model ID that Usage shows without **Map to**, such
as a provider-prefixed ID for Pi. Filters apply before **Map to**, so a model you leave out is not
counted under its mapped name. Usage applies each environment's own filter. Remove the setting to
show every model again.

If the setting is invalid, Usage ignores it and shows every model, and the next save of any other
setting removes it from `settings.json`.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your enabled environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their next 5-hour refill, soonest
first. For an account with no weekly quota left, this is when its session becomes usable again.
The first available window is used when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex and Claude accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude resets are not available when the server runs on macOS, where Claude keeps its login in the
Keychain. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

When a Claude or Codex account has no overall weekly quota left, its pooled session contribution
shows 0% left. The next refill depends on both reset times: an exhausted session must also reset,
and a partly spent session may only regain its unused portion when the week resets. Missing or
stale reset times have no refill estimate; refresh Limits for a new reading. Claude's
model-specific weekly allowances keep their reported values.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

To keep them in view on web and desktop, turn on **Usage limits** in **Settings → Appearance → Thread details**, or right-click the thread details card.
The bottom of the thread details card then shows how much is left in each limit window of the
current provider account. Some windows, such as a weekly Opus limit, count only one model. Hover a
row to see when it resets and your pace. Turn on **Context window** to also show the thread's
context use against the model's limit. A tick on the bar marks where the provider compacts
automatically, when it reports that point.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. T3 cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Limits need an OpenCode Go API key, or an OpenCode Console connected
in OpenCode with an API key. A Console browser sign-in alone does not report them. You can also add
your Go API key as `OPENCODE_API_KEY` in the OpenCode instance's **Environment variables**, then
refresh provider status. Cursor reports
its monthly allowance, including separate Auto and API usage, using the CLI login or
`CURSOR_AUTH_TOKEN`. On macOS, this includes the default Keychain login after you enable Cursor
usage. Keychain login is used for limits only with Cursor's default API endpoint. If you configure
a custom Cursor endpoint, use an explicit token or file-based CLI login for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**; on Android this works while T3 is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen T3 to refresh expired readings.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
