# Usage

Open **Usage** from the sidebar or press `Ctrl+U` to see token totals and API-equivalent
costs for the threads Houston runs on this machine.

Choose **24 hours**, **7 days**, **30 days** or **90 days**, and switch between **Cost**,
**Tokens** and **Limits**. The provider filter hides providers you do not want to see.
**Refresh** reads the current window again.

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

## Model prices

**Model prices** opens the price table. You can add a model price, map a model name to
another model's price, and apply the table to the environments you select. A mapping and
override apply to past and future usage on those environments.

## Limits

**Limits** shows the subscription windows each provider reports: remaining allowance,
reset time and whether you are ahead of, on or under pace. It also shows shared or external
usage, such as ChatGPT shared usage, when the provider exposes it. A provider that reports
no limits is omitted rather than shown as unlimited.

Limits come from the provider account. Houston does not throttle, stop or extend a provider
limit; a limited thread is reported and can be held or resumed from **Settings ▸ Threads**
and the thread's own banner.

## Breakdowns

The breakdown groups usage by model or by time, with tokens, cost and share. The year view
keeps daily totals for up to 365 local calendar days; its colour always represents daily
cost, even when another metric is selected. Select a day to filter the breakdown; clear the
day to return to the whole window.
