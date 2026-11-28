# Usage

Open **Settings ▸ Agents ▸ Usage** or press `Ctrl+U` to see token totals and API-equivalent
costs for the threads Houston runs on this machine.

Choose **24 hours**, **7 days**, **30 days** or **90 days**, and switch between **Cost**,
**Tokens** and **Limits**. The provider filter hides providers you do not want to see.
**Refresh** reads the current window again.

## History retention

**History retention** in **Settings ▸ Agents ▸ Usage** sets how many days Houston keeps saved
Usage records for transcripts a provider has since removed. The range is 1 to 365 days;
**Keep all available history** uses the supported maximum of 365 days, and **Reset** restores
the default of 365 days. The control shows the value currently in effect.

Shortening the window deletes older saved records on the next Usage refresh. Houston asks for
confirmation before applying a shorter window because deleted records cannot be recovered.
Lengthening the window affects later refreshes only: it does not restore records already deleted
and never invents usage that a provider no longer keeps. This setting does not delete provider
transcripts.

## What it counts

Houston reads the usage records the providers already keep on this machine. Prompt text,
tool output, file contents and file references are not retained for Usage; it keeps token
counts, model and session identifiers, reported costs and the project association.

The page reports empty, missing or unreadable sources instead of a zero total. A provider
whose records cannot be read is named. Costs are estimates at API prices, not a bill,
subscription charge or remaining allowance.

Published prices come from LiteLLM's public model catalog, downloaded from GitHub and cached
locally. A failed download preserves the last valid catalog. The catalog request carries no
usage data. A provider-reported cost is used when present; records without usable prices
still contribute tokens and are marked unpriced.

Claude cache writes are priced by their lifetime: one-hour writes at the catalog's one-hour
write rate and five-minute writes at its standard write rate. A model without a published
one-hour rate is priced at the standard rate. Cache write tokens are shown as one count.

## Model prices

**Model prices** opens the price table. You can add a model price, map a model name to
another model's price, and apply the table to the environments you select. A mapping and
override apply to past and future usage on those environments. A custom cache write price
applies to both cache lifetimes.

## Limits

**Limits** shows the subscription windows each provider reports: remaining allowance,
reset time and whether you are ahead of, on or under pace. It also shows shared or external
usage, such as ChatGPT shared usage, when the provider exposes it. A provider that reports
no limits is omitted rather than shown as unlimited. Antigravity reports no limits through
its ACP runtime, so it is omitted; Houston does not use your Google sign-in outside it. Its
tokens and cost still come from Antigravity's local history.

Limits come from the provider account. Houston does not throttle, stop or extend a provider
limit; a limited thread is reported and can be held or resumed from **Settings ▸ Threads**
and the thread's own banner.

With **Hold until limits reset** on, an automatic turn on a thread whose latest run on that
provider failed with a usage limit and whose reported reset is still ahead waits in the thread's
queue instead of starting and failing. Automatic turns are sub-agent results, agent messages,
background and restart notes, pull-request and merge-queue notes, scheduled tasks and limit
resumes. A message you type, a Slack answer and a task run you start are never held and never
wait behind a held item. **Send now** starts a held item at once.

At the reported reset, **Resume after usage limits** starts its continuation first and the held
items follow in queue order; without it, the held items start at the reset. A reset release does
not end a **Stop**: after you press Stop, automatic starts still wait for Resume or a message. A limit whose reset
time the provider does not report is not held, and its error says that the provider did not
report when the limit resets.

**Also hold threads that have not hit the limit**, under **Hold until limits reset**, extends the
hold to every thread on a provider instance whose account is inside a known limit window: a
reported window at 100% with a reset ahead, or a recent limit failure on that account. Automatic
turns on any of its threads wait, and so do new sub-agents; a held sub-agent creates no worktree,
and `delegate_task` returns `status: "queued"` with the reason and reset. A weekly limit that
applies to one model holds only that model. A message you type still starts.

While a hold exists, Houston asks that provider for its own usage reading every 15 minutes and
sends nothing else; the reading goes only to the provider instance you configured. When no reset
time is known, or the reset passed but the provider still refuses, Houston releases one held item
as a test after 15, then 30, then every 60 minutes. A successful test releases the rest in queue
order; a limit failure waits and retries. A hold with no reported reset is marked overdue after
three failed tests or 15 minutes past its next test release; a hold with a reset time ends at
that reset. The state survives a server restart. Providers that report
no limit windows cannot be held this way and are named in the setting's description; Antigravity
is one. One provider account used from two channels, or from the Windows Subsystem for Linux
backend, is tracked separately by each server, so a limit seen in one is not known to the other.

## Breakdowns

The breakdown groups usage by model or by time, with tokens, cost and share. The year view
keeps daily totals for up to 365 local calendar days and follows the history retention window
when that is shorter; its colour always represents daily cost, even when another metric is
selected. Select a day to filter the breakdown; clear the day to return to the whole window.
