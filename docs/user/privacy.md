# Privacy and diagnostics

Houston runs on your machines. Threads, projects, settings and credentials stay in the server's
state directory on the machine that runs it.

## What leaves the machine

- **Agents.** Each provider receives the prompts you send and the files its agent reads, under
  that provider's own terms.
- **MCP server sign-in.** When an agent's MCP server needs a sign-in, the provider's page opens in
  your browser and Houston sends the address it ended on only to the server that runs the thread,
  which validates it and passes it to the agent's own local listener. Houston makes no other
  request for that sign-in.
- **Features you turn on.** Integrations such as GitHub, Slack, Notion, Linear, usage hubs and
  transcript cleanup contact the services you configure for them, and nothing while they are off.
  A connected Linear tracker sends the API key with each request and reads the teams, issues,
  comments and people you open; remove the key under **Settings ? Source control** to disconnect
  it, after which Houston sends nothing to Linear. A connected Notion tracker does the same with
  its integration token: it sends the token with each request and reads the data sources, pages,
  comments and people the bound data source holds, and writes the title, body, labels, assignees,
  state, pull request URL and comment you ask for. Remove the token under **Settings ? Source
  control** to disconnect it, after which Houston sends nothing to Notion.
- **Cloud dictation.** When you choose OpenAI, Grok or OpenRouter under Settings ▸ Voice, the
  environment sends each finished recording to that provider with your API key. Nothing is sent
  while dictation is Off or set to an environment. See [Dictation](dictation.md#network-use).
- **Inference servers.** Houston checks the model servers you register under **Settings →
  Inference** by requesting their model list and, when the engine exposes them, its health,
  metrics and model details. It sends only to the addresses you register and sends a saved API key
  only to the server that key belongs to. **Find servers** probes loopback and the machine's own
  listening ports, never sends a saved key, and saves nothing until you add a server. See
  [Local models](local-models.md). **Check images** sends four generated solid-colour test
  images and a short question only to the server being checked, and stores the answer it found
  without keeping the images.
- **Updates.** Houston checks for new versions of the app and of each agent CLI.

## Usage and crash data

Houston may collect anonymous usage data and crash and diagnostic data to find bugs and improve
the app. That data never includes source code, prompts, agent responses, file contents,
credentials or paths. Before any collection ships, this page lists what is sent, the service that
receives it and how to turn it off. Houston collects none today.

Houston does not use your data to train AI models.

## Exporting diagnostics yourself

**Settings ▸ Maintenance ▸ Diagnostics ▸ OpenTelemetry export** sends the server's traces,
metrics and logs to an OTLP HTTP receiver you choose, such as a local Jaeger or Grafana
instance. Leave the fields empty to export nothing. Changes apply after the server restarts.

An export contains span names and timings, Houston's own ids, outcomes and error types, the
host of each outgoing request, SQL statements with their values as placeholders, and the
service's name, version, release channel and Node.js version. Log records carry their level,
time, ids and error type, but no message text. An export never contains paths, URLs beyond
their host, error or log messages, the machine's name, prompts, agent responses, file contents
or credentials. The trace file on this machine keeps full detail.

**Datadog** as the destination sends that export to the Datadog site you choose
(`https://otlp.<site>`) with your Datadog API key. Traces are on by default; metrics and logs
are off until you turn them on. The key is stored in the server's secret store on this machine,
never in settings, and Houston sends it only to that site. Removing the key stops the export
from the next send, and a replaced key is used from the next send, without a restart; a key
added while none was stored, and choosing **Off**, take effect after the server restarts. A
signal you leave off for Datadog uses its own URL field, if you filled one in, and is sent there
without the key. **Datadog Agent on this machine** sends the same export to a local Agent
without a key; the Agent forwards it with its own. Houston ships no Datadog key and sends
nothing to Datadog unless you configure it.

For each signal, the first of these that is set decides where it goes:

1. `HOUSTON_OTLP_TRACES_URL`, `HOUSTON_OTLP_METRICS_URL` or `HOUSTON_OTLP_LOGS_URL` in the
   server's environment.
2. The standard `OTEL_EXPORTER_OTLP_*` endpoint variables (`OTEL_SDK_DISABLED=true` or
   `OTEL_<SIGNAL>_EXPORTER=none` turns the signal off).
3. A URL the desktop app passes to the server at start.
4. The Datadog destination, for the signals it sends.
5. The URL fields in **Settings ▸ Maintenance ▸ Diagnostics ▸ OpenTelemetry export**.

An environment URL wins over a Datadog choice even when it points at a Datadog site, and it is
sent with only the headers its own variables give: Houston never adds the stored key to it.

## The error log on this machine

The server and the desktop app each keep a small error log, so that a failure can still be
diagnosed after the trace file has rotated. It is always on. Houston never sends it anywhere; a
triage agent you start can read the logs folder, under its provider's own terms.

An entry holds the time, the log level, the name of the operation that failed and how long it took,
its trace ids, the type of the error or of the value logged with it, and the code locations
(function, file name, line and column) that lie in Houston's own program files or in Node.js; other
locations are only counted. It also holds fields under fixed names and prefixes: numbers,
booleans, kinds and outcomes that code or a standard defines, and identifiers whose every part has
the form of a random id, a digest or a number, or is one of Houston's own fixed words. An identifier
that contains anything else, such as a key an agent worded or a name you gave a provider instance,
is left out, and the entry counts it. It holds no log or error messages, paths, URLs, prompts, agent
responses, file contents, SQL statements or credentials.

The files are `server.errors-<date>.ndjson` and `desktop.errors-<date>.ndjson` in the
`userdata/logs` folder of the server's state directory (`~/.houston/v2/userdata/logs` for the
installed release; a WSL server keeps its own inside the distribution). Houston keeps today's file
and the seven before it, in UTC days, and each process writes at most 2 MiB a day. Older files are
removed when Houston starts and when a later day's first failure is recorded; the **rotated logs**
storage setting does not change this. To delete the log, delete those files; Houston needs none of
them.
