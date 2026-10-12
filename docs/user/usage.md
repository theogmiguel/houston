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

The workspace filter uses the transcript's recorded working directory. Sessions inside
a registered workspace or one of its worktrees belong to that workspace; other sessions
remain in **All workspaces**. Unsupported agents, including OpenCode, Cursor, Grok,
Antigravity and ZCode, are named as not counted rather than reported as zero usage.

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
cached locally. Automatic catalog checks follow Settings ▸ System ▸ About ▸ **Check
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

Days whose transcripts have been removed retain their recorded daily total, but cannot
supply model or session detail. History begins when a scan records a day; Houston cannot
reconstruct usage from transcripts that were deleted before it read them.
