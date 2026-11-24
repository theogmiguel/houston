# Local models

Houston does not run models itself. **Settings → Inference** registers the OpenAI-compatible
model servers on this machine or your network so Houston can check that they answer and show
their models, context windows and load. Ollama, LM Studio, llama.cpp's `llama-server`, vLLM,
SGLang and other servers that answer `GET /v1/models` are detected.

The address must be reachable from the machine running the Houston server. `localhost` means that
machine, even when you are connected from a phone or another computer.

## Use a local model in one step

**Use a local model** finds a model server, links an agent to it and makes one of its models the
default for new threads. It is offered during first-run setup, in **Settings → Inference**, in
the model picker while no local model exists, and in the command palette.

It searches the environment's machine and the servers you already registered. Pick the server
and model, then the agent: Pi and OpenCode are offered, in that order, when they speak the
server's API. The dialog states what it will change before it does: add or reuse the server, link
the agent, and set the default. Each change is a normal settings entry, so it can be changed or
undone in **Settings → Inference** and **Settings → Providers**. Running it again reuses the
server and linked agent it created.

If the agent is not installed or has not listed the model yet, the server and link are kept and
the dialog says what is missing. A search that only knows well-known ports on Windows says so;
enter another address to check it.

## Register a server

Open **Settings → Inference** and choose **Add server**:

- **Base URL** — the server's OpenAI-compatible root, such as `http://localhost:11434/v1`.
  Houston adds `/v1` when you give only a host.
- **Name** — optional. The host name is used when it is empty.
- **API key** — optional. A server that requires one answers `401` until it is set.
- **Max concurrent requests** — optional. It overrides the count Houston reports for the
  server, such as TensorFold's batch size or llama.cpp's slots.

Houston checks each enabled server on its own interval after it is added, and **Refresh** checks
again immediately. A row shows:

- whether the server is **Ready**, **Unreachable** or in **Error**, with a message when it is not
  ready;
- the engine it reports, such as Ollama, LM Studio, llama.cpp, vLLM or TensorFold;
- its models and the context window each one serves, or the trained window when it serves none;
- whether the engine reports, or a check found, that a model reads images;
- running and waiting requests when the engine exposes metrics;
- how long ago it was checked.

**Edit** changes a server's address, name, key or request limit. A blank API key keeps the saved
one. **Remove** deletes the server and its saved key.

## Check whether a model reads images

Pi and OpenCode pass your image attachments to a linked model unless its engine or Houston's
check says it reads text only. To check a model, press **Check images** next to it in
**Settings → Inference**; attaching an image to a model nobody has checked also starts the
check. Houston sends four solid-colour test images through the same queue as your threads and
asks the model to name each colour, with a short answer limit and at most two minutes. It marks
the model **Reads images** or **Text only**; a text-only result applies to sessions that start
afterwards. Checking again is offered a day after a result, in case the server now runs
different weights under the same name.

A check records nothing when it cannot tell: the server is busy or times out, the reply is cut
off while reasoning, or the answer names no colour. Those leave the model unchanged and can be
tried again.

While an image is attached to a linked model that reads text only, the composer says the model
will not see it, with **Choose model**. For a model nobody has checked, the composer says the
check is running or the result is unknown and offers **Check images**; the image is still sent,
so a server that cannot read it refuses it visibly.

## Repair a server that moved

When a registered server stops answering, its row offers **Check again**, **Find server** and
**Change address**. **Find server** searches that server's machine, points out an address that
serves the same model, and moves the server there. Its id, saved key and linked agents stay, so
existing `houston-<server>` models keep working; threads already running keep the old address
until their agent session restarts. **Change address** edits the address by hand.

A thread whose selected agent is linked to a down server says so above the message box, with
**Check again** and **Find server**.

## When a server no longer serves the model

A linked agent's model can disappear when its server swaps models. If the server is checked and
ready but no longer lists the model a thread uses, the composer says which model is missing and
what the server serves now, with **Choose model** and **Check again**. A server that is being
checked or is down is not reported this way.

## Use a server in an agent

Pi and OpenCode can send their model traffic through a registered server. Open the agent's
instance in **Settings → Providers**, set **Model server**, and pick a registered server. The
instance counts as local while that server is enabled, so it leads the provider list and handles
background writing; turning the server off makes it a cloud instance again. A linked instance
whose server is down, removed or not ready waits with a message naming the server rather than
falling back to its own cloud models. Changing the link affects new sessions; a running session
keeps the route it started with.

A linked Pi instance discovers the server's models through Houston's gateway and offers them as
`houston-<server>` models, with the context window and output limit the server reports. Pi gets a
gateway credential for each provider session, and text generation borrows a short-lived one.
OpenCode receives the server as a `houston-<server>` provider in its configuration, and a shared
OpenCode process restarts when the served models change. Its requests are counted per thread
from OpenCode's own session id.

Other agents cannot use an inference server yet because they have no OpenAI-compatible endpoint
setting; linking one shows that refusal by name.

### Lean tools

A Pi instance linked to a server uses the **Lean** Houston tool profile unless you choose **Full**
under the instance's **Houston tools** setting. Lean advertises only Houston's orchestration,
thread, project, worktree and secret tools, leaving device, preview, HTML, pull request,
attachment and queue tools out, and it omits the preview guidance it would otherwise include.
The smaller tool list leaves more of a local model's context for the work.

## API keys

A server's API key is stored in the Houston server's secret store on that machine, never in
`settings.json`, logs, errors or replies to clients. A probe or a search sends a saved key only to
the address that key belongs to.

## Find servers

**Find servers** searches this machine and shows every model server that answers. It checks the
well-known ports 11434 (Ollama), 1234 (LM Studio), 8080, 8000 and 30000 on loopback. On Linux it
also checks every port the machine listens on, so a server on another port is still found.

The search never sends a saved API key. A server that requires one is listed as **Needs an API
key**; add it and enter the key. Servers on another machine are searched only on the well-known
ports when you enter that address with **Add server**.

On Windows, only the well-known ports are searched; Windows has no equivalent of the Linux
listening-port table, so a server on another port must be added by its address.

## Servers on your other machines

Inference servers belong to one machine. **Settings → Inference** on one machine lists servers
registered on the user's other connected Houston environments, with **Add here**. The add form is
prefilled with the address this machine would use: a `localhost` address becomes the other
machine's host name, or its LAN address when the label is not a host name. A server this machine
already has at that address or under that id is not offered.

API keys are never copied between machines. Enter the key again when the origin server uses one.
An environment whose server version has no inference support is named as such instead of offering
a button that cannot work.

## Windows and WSL

A Houston server inside WSL runs in a different network from Windows. It cannot reach a model
server on the Windows host through `localhost` unless WSL mirrored networking is enabled. Enter
the host's address instead, such as the address Windows shows for the machine.

## The gateway

Houston reaches a registered server through its own gateway at
`<server>/inference/<serverId>/v1`, so anything that speaks the OpenAI Chat Completions,
Completions or Responses API, or the Anthropic Messages API, can use it without knowing the
server's address or key. The gateway forwards only those four routes and `GET /v1/models`.

### Queue

Each server has its own queue. Its capacity is **Max concurrent requests**, or the batch size or
slot count the server reports, or one. A request waits for a free slot in this order: your chat
first, then scheduled tasks, then Houston's background writing; a lower class that has waited
30 seconds ranks with chat so it is not starved. At most 64 requests wait per server, and none
waits longer than 10 minutes. A refusal names the limit: how many are waiting, the bound, and the
operation that could not start.

### Fallback

**Edit → Fallback server** names another registered server to take this one's work while it is
down or unreachable. The fallback is used only when the connection fails before the request
reaches the primary, or when the primary is not ready; it never takes over a request already
running, and a queued primary does not overflow to an idle fallback. The fallback must list the
same model, serve the same protocol, and fit the request in its context window. A request that
continues an earlier Responses API reply stays on the server that issued it.

### Watchdog

While a reply streams, the gateway stops it if the model repeats the same text (a 64–1024
character unit at least 8 times and over 4 KiB, seen twice), if it reasons for 128 KiB without
answering or calling a tool, if no first token arrives within 5 minutes, or if nothing arrives
for 2 minutes after it started. A stopped reply ends with the protocol's own error event so the
agent ends the turn instead of treating it as complete. It cannot retry the same run for a
minute; send a new message to continue. Turn the watchdog off per server in **Edit**.

### What is recorded

Each request records its server, model, who asked (a chat turn, a scheduled task or background
writing), thread and run, outcome, a bounded failure cause, HTTP status, prompt, cached,
completion and reasoning tokens, queue wait, time to first token, decode speed, whether a
fallback served it, and a short fingerprint of the static system-and-tools prefix. Request and
response text is never stored. Rows older than a week are removed as new requests arrive.

Houston reports 24-hour and 7-day totals with p50 and p95 queue wait, time to first token and
decode speed. The **Usage** page's **Local compute** section groups these by server and model,
with requests, failures and the gateway's advice, prompt and completion tokens, the cached share,
and the p50/p95 measurements; local work is never shown as cloud spend. A waiting thread shows its
place in the server's queue, and thread details show the thread's last request: server, model,
tokens, cached share, queue wait, time to first token, decode speed and any fallback.

When the watchdog stops a reply, the thread says why, such as "Stopped a looping reply", with
**Continue** and **Choose model** actions. **Settings → Inference** shows each server's Houston
queue, prompt-cache health (TensorFold), how long ago it was checked and its latest failure, and
lets you choose a fallback server.
