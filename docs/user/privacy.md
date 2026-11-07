# Privacy and diagnostics

Houston runs on your machines. Threads, projects, settings and credentials stay in the server's
state directory on the machine that runs it.

## What leaves the machine

- **Agents.** Each provider receives the prompts you send and the files its agent reads, under
  that provider's own terms.
- **Features you turn on.** Integrations such as GitHub, Slack, Notion, usage hubs and transcript
  cleanup contact the services you configure for them, and nothing while they are off.
- **Cloud dictation.** When you choose OpenAI, Grok or OpenRouter under Settings ▸ Voice, the
  environment sends each finished recording to that provider with your API key. Nothing is sent
  while dictation is Off or set to an environment. See [Dictation](dictation.md#network-use).
- **Updates.** Houston checks for new versions of the app and of each agent CLI.

## Usage and crash data

Houston may collect anonymous usage data and crash and diagnostic data to find bugs and improve
the app. That data never includes source code, prompts, agent responses, file contents,
credentials or paths. Before any collection ships, this page lists what is sent, the service that
receives it and how to turn it off. Houston collects none today.

Houston does not use your data to train AI models.

## Exporting diagnostics yourself

**Settings ▸ Diagnostics ▸ OpenTelemetry export** sends the server's traces, metrics and logs to
an OTLP HTTP receiver you choose, such as a local Jaeger or Grafana instance. Leave the fields
empty to export nothing. Changes apply after the server restarts.

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
5. The URL fields in **Settings ▸ Diagnostics ▸ OpenTelemetry export**.

An environment URL wins over a Datadog choice even when it points at a Datadog site, and it is
sent with only the headers its own variables give: Houston never adds the stored key to it.
