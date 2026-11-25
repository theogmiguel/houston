# Agent status

Houston learns what an agent is doing from the provider's structured stream, through its
provider adapter. It does not read terminal output to decide whether an agent is working,
waiting or finished.

## Thread status

A thread can show:

- **Connecting** — the run is starting or queued.
- **Running** — a turn is in progress.
- **Waiting** — the run is waiting on a child thread or on background work.
- **Needs you** — the agent asked a question.
- **Pending Approval** — the agent is waiting for you to approve an action.
- **Plan Ready** — the agent finished a proposed plan and waits for your decision.
- **Failed** — the last run failed and you have not seen the failure.
- **Ready** — the last run finished and you have not seen the result.
- **Back** — a held thread woke up.
- **Limited** — the provider reported a usage limit; the detail names the limit and, when
  the provider reports one, the reset time.

The same marks appear in the sidebar and the command palette: a turning ring for
running, a check for ready, a question mark for a question, a cross for failed, a clock
for back.

When a provider reports that it is retrying a request, the thread shows a **Provider retry**
row. A turn that stays in retries for 10 minutes without recovering is stopped and fails with
the retry's error. A wait the provider asks for before its next attempt, or a usage-limit
reset time it names, extends the limit by that wait; with Claude's usual backoff over its 10
retries the turn ends after about 13 minutes. A usage-limit retry still fails as a usage limit,
so the thread shows **Limited** and follows the usage-limit settings below.

Claude, Codex, OpenCode, Pi and the Mistral Vibe ACP agent report retries this way. Muse Code
shows its retries as notices, and Cursor, Grok, fx, Kiro, Antigravity and the other ACP
registry agents do not report retries, so this limit does not apply to them.

A child thread that is delegated work reports to its parent as well as appearing in its own
tab. Its question or approval request shows in the parent's pending approvals; the parent
answers there.

After **Stop**, **Resume** in the composer asks the agent to continue with "Continue where
you left off." When the provider had not yet received the stopped message, Resume sends
that message again, with its context and attachments. A stopped compaction is not offered
for Resume; run it again.

A message you sent that the provider had not confirmed receiving when Houston restarted waits
in the queue instead of being cancelled. The agent may already have acted on it, so check
before you release it. **Resume** releases it; another message you send runs first, then this
one is sent automatically. Discard it first if you are retyping it. A `/compact` that was
already running is cancelled; send it again to compact.

**Settings ▸ Threads** sets whether a hold and a resume follow usage limits: **Hold until
limits reset** parks a limited thread, and **Resume after usage limits** continues it when
the limit clears.

## Provider readiness

A provider can be installed and still unable to run. Settings, the model picker, first run
and a thread banner show one readiness state and one action:

- **Not installed** — the provider's executable or runtime is missing.
- **Turned off** — the provider instance is disabled in **Settings ▸ Providers**.
- **Signed out** — sign in with the provider again.
- **Credentials rejected** — the provider refused the stored credentials.
- **Out of usage** — the account reached its limit; the reset time is shown when the
  provider reports it. A limit on one model, such as Claude's weekly Opus limit, stops only
  the thread that hit it; the provider stays ready for its other models.
- **Ready** — the provider can run threads.

A thread cannot start on a provider that is not ready. The refusal names the provider and
the reason, and the banner's action opens the page that resolves it. A fallback model can be
set in **Settings ▸ Threads** for new threads when the default provider is out of usage.

## Usage limits

Usage limits come from the provider, not from Houston's own accounting. Provider usage
windows, remaining allowance and reset times are shown in **Usage** under **Limits** and in
a thread's details card. A run stopped by a limit keeps its state and can be resumed after
the reset when the settings above allow it.

## Notifications

**Settings ▸ General ▸ Notifications** controls system and in-app notices when a thread
finishes, fails or needs you. See [Notifications](notifications.md).
