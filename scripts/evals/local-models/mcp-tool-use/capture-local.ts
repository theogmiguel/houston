#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalRandom:off globalFetch:off
/**
 * Captures what Codex or OpenCode sends a server linked through Houston's gateway, driven as Houston drives
 * it. A scripted stub plays the model and an MCP stub serves this checkout's Houston tools, so no GPU is
 * needed. Usage: `pnpm mcp-tool-use:capture-local <codex|opencode>`. Read the output before commit.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeZlib from "node:zlib";

import { OPENCODE_THREAD_ID, openCodeToolsHash, type OpenCodeVariant } from "./opencode.ts";
import { visibleT3Tools } from "./tools.ts";

/** Codex's model catalog entry for the served models, as Houston's gateway launch writes it. */
const codexModelCatalog = (server: { readonly models: ReadonlyArray<unknown> }) => ({
  models: (
    server.models as ReadonlyArray<{
      readonly id: string;
      readonly contextWindow?: number;
      readonly reasoningEfforts?: ReadonlyArray<string>;
    }>
  ).map((model) => ({
    slug: model.id,
    display_name: model.id,
    ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
    supported_reasoning_levels: (model.reasoningEfforts ?? []).map((effort) => ({
      effort,
      description: effort,
    })),
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    base_instructions: "Captured template",
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: ["text"],
  })),
});

const MODEL = "GLM-5.3-Flash";
const CWD = "/home/user/app";
const MARKER = "HOUSTON_INSTRUCTIONS_PLACEHOLDER";
const PROMPT = "HOUSTON_PROMPT_PLACEHOLDER";
type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Houston's tools as its MCP server lists them, for one variant of the session. */
const mcpTools = (variant: OpenCodeVariant) =>
  visibleT3Tools({ subagent: variant.subagent, links: variant.links, profile: "full" }).map(
    (tool) => ({
      name: tool.name.replace(/^mcp__houston__/, ""),
      description: tool.description,
      inputSchema: tool.input_schema,
    }),
  );

/**
 * The model stub. Requests with tools are agent turns: the first answers with `first`, later ones
 * end the turn. Others (OpenCode's title request) get a title.
 */
const startModel = async (
  protocol: "chat" | "responses",
  first: Json,
): Promise<{ readonly url: string; readonly turns: Array<Json>; readonly close: () => void }> => {
  const turns: Array<Json> = [];
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Json;
      const agent = Array.isArray(body.tools);
      if (agent) turns.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const write = (event: Json) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      if (protocol === "chat") {
        const delta =
          agent && turns.length === 1 ? first : { content: agent ? "OK" : "Captured template" };
        const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: MODEL };
        const finish = "tool_calls" in delta ? "tool_calls" : "stop";
        write({ ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta } }] });
        write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        write({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
        response.end("data: [DONE]\n\n");
        return;
      }
      const output =
        turns.length === 1
          ? first.output
          : [
              {
                type: "message",
                id: "msg_2",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "OK", annotations: [] }],
              },
            ];
      const items = Array.isArray(output) ? output : [];
      const created = { id: `resp_${turns.length}`, object: "response", status: "in_progress" };
      write({ type: "response.created", response: { ...created, output: [] } });
      items.forEach((item: unknown, index) =>
        write({ type: "response.output_item.done", output_index: index, item }),
      );
      const usage = {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      };
      write({
        type: "response.completed",
        response: { ...created, status: "completed", output: items, usage },
      });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = isRecord(address) ? Number(address.port) : 0;
  return { url: `http://127.0.0.1:${port}/v1`, turns, close: () => server.close() };
};

const poll = async (probe: () => boolean | Promise<boolean>, what: string, ms = 60_000) => {
  for (const started = Date.now(); !(await probe());) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

/** Replaces the capture's scratch directories: the project with the eval's working directory. */
const anonymize = (value: unknown, paths: ReadonlyArray<string>, codexHome?: string): unknown => {
  let text = JSON.stringify(value);
  if (codexHome !== undefined) text = text.replaceAll(codexHome, "/home/user/.codex");
  for (const path of paths.toSorted((a, b) => b.length - a.length)) {
    text = text.replaceAll(path, CWD);
  }
  return JSON.parse(text);
};

const mcpStubCommand = (toolsFile: string) => [
  process.execPath,
  NodePath.join(import.meta.dirname, "mcp-stub.ts"),
  toolsFile,
];

const version = (command: string) =>
  NodeChildProcess.execFileSync(command, ["--version"], { encoding: "utf8" }).trim();

/** Codex app-server as Houston's adapter starts a linked session, with the stub as the gateway. */
const captureCodex = async (scratch: string) => {
  const project = NodePath.join(scratch, "project");
  NodeFS.mkdirSync(project);
  const home = NodePath.join(scratch, "codex-home");
  NodeFS.mkdirSync(home);
  const catalog = NodePath.join(scratch, "catalog.json");
  const server = {
    serverId: "rtx",
    displayName: "rtx",
    models: [{ id: MODEL, contextWindow: 813_056, reasoningEfforts: ["max", "high", "low"] }],
  };
  NodeFS.writeFileSync(catalog, JSON.stringify(codexModelCatalog(server as never)));
  const toolsFile = NodePath.join(scratch, "tools.json");
  NodeFS.writeFileSync(toolsFile, JSON.stringify(mcpTools({ subagent: false, links: false })));
  const model = await startModel("responses", {
    output: [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_mcp",
        namespace: "mcp__houston",
        name: "orchestrator_capabilities",
        arguments: "{}",
        status: "completed",
      },
      {
        type: "function_call",
        id: "fc_2",
        call_id: "call_shell",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "echo captured" }),
        status: "completed",
      },
    ],
  });
  const [command, ...stubArgs] = mcpStubCommand(toolsFile);
  const stub = { command, args: stubArgs };
  const child = NodeChildProcess.spawn(
    "codex",
    [
      "app-server",
      "-c",
      `model_providers.houston-rtx={name="rtx (Houston)",base_url=${JSON.stringify(model.url)},wire_api="responses",env_key="HOUSTON_INFERENCE_TOKEN"}`,
      "-c",
      'model_provider="houston-rtx"',
      "-c",
      "features.multi_agent=false",
      "-c",
      'web_search="disabled"',
      "-c",
      `model_catalog_json=${JSON.stringify(catalog)}`,
    ],
    {
      cwd: project,
      env: { ...process.env, CODEX_HOME: home, HOME: scratch, HOUSTON_INFERENCE_TOKEN: "capture" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const waiting = new Map<number, (message: Json) => void>();
  let next = 1;
  let completed = false;
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Json;
    if (typeof message.id === "number" && waiting.has(message.id)) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
    if (message.method === "turn/completed") completed = true;
  });
  const request = (method: string, params: Json) =>
    new Promise<Json>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    await request("initialize", {
      clientInfo: { name: "houston", title: "Houston", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    // Codex installs its bundled skills into a new home at startup; the prompt lists them.
    await poll(() => NodeFS.existsSync(NodePath.join(home, "skills", ".system")), "Codex's skills");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // CODEX_THREAD_CONFIG and the two T3 MCP registrations in CodexAdapterV2.
    const started = await request("thread/start", {
      cwd: project,
      model: MODEL,
      config: {
        "tools.update_plan.enabled": true,
        mcp_optional_startup_grace_ms: 10_000,
        "mcp_servers.houston": { ...stub, disabled_tools: ["houston_thread_wait"] },
        "mcp_servers.houston-direct": {
          ...stub,
          enabled_tools: ["houston_thread_wait"],
          omit_tools_from: ["code_mode", "deferred"],
        },
      },
    });
    const result = isRecord(started.result) ? started.result : {};
    const thread = isRecord(result.thread) ? result.thread : {};
    // buildCodexTurnStartParams for a full-access default-mode turn.
    await request("turn/start", {
      threadId: thread.id,
      cwd: project,
      model: MODEL,
      input: [{ type: "text", text: PROMPT, text_elements: [] }],
      additionalContext: { houston_runtime: { kind: "application", value: MARKER } },
      summary: "detailed",
      approvalsReviewer: "user",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      effort: "high",
      collaborationMode: { mode: "default", settings: { model: MODEL, reasoning_effort: "high" } },
    });
    await poll(() => completed && model.turns.length >= 2, "Codex's turn");
  } finally {
    child.kill();
    model.close();
  }
  const [first, second] = model.turns as [Json, Json];
  const firstInput = Array.isArray(first.input) ? first.input : [];
  const secondInput = Array.isArray(second.input) ? second.input : [];
  const text = (item: unknown) => JSON.stringify(item);
  const { prompt_cache_key: _key, client_metadata: _metadata, input: _input, ...request_ } = first;
  const input = firstInput
    .filter((item) => !text(item).includes(MARKER) && !text(item).includes(PROMPT))
    .map((item: Json) => {
      const { id: _id, ...rest } = item;
      const content = Array.isArray(rest.content) ? rest.content : [];
      return {
        ...rest,
        content: content.map((part: Json) =>
          typeof part.text === "string"
            ? {
                ...part,
                // HOME is a scratch directory, so the only skills are Codex's bundled ones.
                text: part.text
                  .replace(/<timezone>.*<\/timezone>/, "<timezone>UTC</timezone>")
                  .replace(/<current_date>.*<\/current_date>/, "<current_date></current_date>"),
              }
            : part,
        ),
      };
    });
  const replay = secondInput.slice(firstInput.length);
  return {
    source: {
      harness: `${version("codex")} app-server, linked through Houston's inference gateway`,
      captured: new Date().toISOString().slice(0, 10),
    },
    // Houston's tools come from the checkout at run time; the namespaces keep only their wrapper.
    request: {
      provider_native: anonymize(
        {
          ...request_,
          tools: (Array.isArray(request_.tools) ? request_.tools : []).map((tool: Json) =>
            tool.type === "namespace" ? { ...tool, tools: [] } : tool,
          ),
          input,
        },
        [project, scratch],
        home,
      ),
    },
    replay: anonymize(replay, [project, scratch], home),
  };
};

const VARIANTS: ReadonlyArray<OpenCodeVariant> = [
  { subagent: false, links: false },
  { subagent: false, links: true },
  { subagent: true, links: false },
  { subagent: true, links: true },
];

/** One OpenCode 2 server per variant, set up as Houston's OpenCode 2 adapter sets up a turn. */
const captureOpenCodeVariant = async (scratch: string, variant: OpenCodeVariant) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "variant-"));
  const project = NodePath.join(dir, "project");
  NodeFS.mkdirSync(project);
  NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: project });
  const tools = mcpTools(variant);
  const toolsFile = NodePath.join(dir, "tools.json");
  NodeFS.writeFileSync(toolsFile, JSON.stringify(tools));
  const server = `houston-${OPENCODE_THREAD_ID}`;
  // Every item search can list, and one T3 call to show how a result comes back.
  const code = `const found = await search({ limit: 1000 }); const call = await tools[${JSON.stringify(server)}].orchestrator_capabilities({}); return { found, call };`;
  const model = await startModel("chat", {
    tool_calls: [
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "execute", arguments: JSON.stringify({ code }) },
      },
    ],
  });
  const password = "capture";
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  // withOpenCodeGateway's overlay for one served model.
  const overlay = {
    provider: {
      "houston-rtx": {
        npm: "@ai-sdk/openai-compatible",
        name: "rtx (Houston)",
        options: { baseURL: model.url, apiKey: "{env:HOUSTON_INFERENCE_TOKEN}" },
        models: {
          [MODEL]: { name: MODEL, reasoning: true, limit: { context: 813_056, output: 813_056 } },
        },
      },
    },
  };
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: NodePath.join(dir, "config"),
    XDG_DATA_HOME: NodePath.join(dir, "data"),
    XDG_STATE_HOME: NodePath.join(dir, "state"),
    XDG_CACHE_HOME: NodePath.join(dir, "cache"),
    OPENCODE_PASSWORD: password,
    HOUSTON_INFERENCE_TOKEN: "capture",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay),
  };
  const child = NodeChildProcess.spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", `--port=${port}`],
    { cwd: project, env, stdio: "ignore" },
  );
  const base = `http://127.0.0.1:${port}/api`;
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
  const location = `location%5Bdirectory%5D=${encodeURIComponent(project)}`;
  try {
    await poll(
      () =>
        call("GET", "/info").then(
          () => true,
          () => false,
        ),
      "OpenCode to start",
    );
    // sessionRules for full access, then mcpRules for this thread's server.
    const created = (await call("POST", "/session", {
      model: { id: MODEL, providerID: "houston-rtx" },
      location: { directory: project },
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "houston-*", resource: "*", effect: "deny" },
        { action: `${server}_*`, resource: "*", effect: "allow" },
      ],
    })) as Json;
    const session = isRecord(created.data) ? created.data : {};
    await call("PUT", `/experimental/mcp/${server}?${location}`, {
      config: { type: "local", command: mcpStubCommand(toolsFile) },
    });
    await poll(async () => {
      const listed = JSON.stringify(await call("GET", `/mcp?${location}`));
      return listed.includes('"connected"');
    }, "the MCP stub to connect");
    // OpenCode lists a server's tools a moment after it reports the server connected.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await call("PUT", `/experimental/session/${String(session.id)}/instructions/entries/houston`, {
      value: MARKER,
    });
    await call("POST", `/session/${String(session.id)}/prompt`, { text: PROMPT });
    await poll(() => model.turns.length >= 2, "OpenCode's turn");
  } finally {
    child.kill();
    model.close();
  }
  const [first, second] = model.turns as [Json, Json];
  const messages = Array.isArray(first.messages) ? (first.messages as ReadonlyArray<Json>) : [];
  const system = String(messages[0]?.content ?? "")
    .replace(/Today's date: .*/, "Today's date: {{DATE}}")
    .replace(MARKER, "{{HOUSTON_INSTRUCTIONS}}");
  if (!system.includes("{{HOUSTON_INSTRUCTIONS}}") || !system.includes(server)) {
    throw new Error(`OpenCode's system prompt lacks Houston's instructions or tools:\n${system}`);
  }
  const later = Array.isArray(second.messages) ? (second.messages as ReadonlyArray<Json>) : [];
  const result = later.find((message) => message.role === "tool");
  const saved = /full output saved to (\S+?)\]?$/m.exec(String(result?.content ?? ""))?.[1];
  const full = saved ? NodeFS.readFileSync(saved, "utf8") : String(result?.content ?? "");
  const parsed = JSON.parse(full) as Json;
  const found = isRecord(parsed.found) ? parsed.found : {};
  return anonymize(
    {
      request: first,
      system,
      search: found.items,
      callResult: parsed.call,
      toolsHash: openCodeToolsHash(tools),
      truncatedResult: saved
        ? String(result?.content ?? "")
            .split("\n")
            .slice(-1)[0]
        : undefined,
    },
    [project, dir, scratch],
  ) as Json;
};

const captureOpenCode = async (scratch: string) => {
  const variants: Record<string, Json> = {};
  let request: Json = {};
  let callResult: unknown;
  let truncated: unknown;
  for (const variant of VARIANTS) {
    const captured = await captureOpenCodeVariant(scratch, variant);
    const key = `${variant.subagent ? "child" : "top"}${variant.links ? "+links" : ""}`;
    variants[key] = {
      toolsHash: captured.toolsHash,
      system: captured.system,
      search: captured.search,
    };
    request = isRecord(captured.request) ? captured.request : {};
    callResult = captured.callResult;
    truncated ??= captured.truncatedResult;
  }
  const { messages: _messages, ...rest } = request;
  return {
    source: {
      harness: `opencode ${version("opencode").replace(/^opencode\s*/, "")} serve, linked through Houston's inference gateway`,
      captured: new Date().toISOString().slice(0, 10),
    },
    request: { provider_native: rest },
    mcpServer: `houston-${OPENCODE_THREAD_ID}`,
    variants,
    replay: { callResult, truncated },
  };
};

const main = async () => {
  const [harness, outArg] = process.argv.slice(2);
  if (harness !== "codex" && harness !== "opencode") {
    throw new Error("Usage: capture-local.ts <codex|opencode> [out.json.gz]");
  }
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-capture-"));
  try {
    const template =
      harness === "codex" ? await captureCodex(scratch) : await captureOpenCode(scratch);
    const out =
      outArg ??
      NodePath.join(
        import.meta.dirname,
        "templates",
        harness === "codex" ? "codex-local.json.gz" : "opencode.json.gz",
      );
    NodeFS.writeFileSync(out, NodeZlib.gzipSync(`${JSON.stringify(template)}\n`));
    const digest = NodeCrypto.createHash("sha256").update(JSON.stringify(template)).digest("hex");
    process.stdout.write(`Wrote ${out} (${digest.slice(0, 12)}).\n`);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
};

await main();
