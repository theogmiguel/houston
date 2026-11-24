# Local models

Houston does not run models itself. **Settings → Inference** registers the OpenAI-compatible
model servers on this machine or your network so Houston can check that they answer and show
their models, context windows and load. Ollama, LM Studio, llama.cpp's `llama-server`, vLLM,
SGLang and other servers that answer `GET /v1/models` are detected.

The address must be reachable from the machine running the Houston server. `localhost` means that
machine, even when you are connected from a phone or another computer.

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
- whether the engine reports that a model reads images;
- running and waiting requests when the engine exposes metrics;
- how long ago it was checked.

**Edit** changes a server's address, name, key or request limit. A blank API key keeps the saved
one. **Remove** deletes the server and its saved key.

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

## Windows and WSL

A Houston server inside WSL runs in a different network from Windows. It cannot reach a model
server on the Windows host through `localhost` unless WSL mirrored networking is enabled. Enter
the host's address instead, such as the address Windows shows for the machine.
