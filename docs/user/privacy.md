# Privacy and diagnostics

Houston runs on your machines. Threads, projects, settings and credentials stay in the server's
state directory on the machine that runs it.

## What leaves the machine

- **Agents.** Each provider receives the prompts you send and the files its agent reads, under
  that provider's own terms.
- **Features you turn on.** Integrations such as GitHub, Slack, Notion, usage hubs and transcript
  cleanup contact the services you configure for them, and nothing while they are off.
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
