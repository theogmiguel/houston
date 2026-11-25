#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off
/**
 * Manual eval: drives Pi, Codex and OpenCode against one local model through the gateway rules.
 * It never runs in CI or `pnpm test`; its unit tests use fixtures only.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { HOUSTON_ORCHESTRATION_INSTRUCTIONS } from "@houston-app/provider-core/server/orchestrationInstructions";

import {
  codexLocalCallName,
  codexLocalTools,
  gatewayRequest,
  gatewayResponse,
} from "./codex-local.ts";
import {
  type CallMetrics,
  emptyValidity,
  localSummary,
  noteInvalid,
  reportedTtft,
  schemaProblem,
  staticPrefixHash,
  type Validity,
} from "./harness-metrics.ts";
import {
  executeOpenCode,
  openCodeInput,
  openCodeSystem,
  type OpenCodeSearchItem,
} from "./opencode.ts";
import { chatTool, type PiTemplate, piNativeTools, piSystemPrompt } from "./pi.ts";
import { HOUSTON_MCP_PREFIX, visibleT3Tools } from "./tools.ts";

type Json = Record<string, unknown>;
type Harness = "pi" | "codex" | "opencode";

interface EvalCase {
  readonly id: string;
  readonly prompt: string;
  readonly tool: string;
}

const CASES: ReadonlyArray<EvalCase> = [
  {
    id: "delegate",
    prompt:
      "Start one child agent to summarize the README. Use the delegate_task tool with the task " +
      '"Summarize the README." Make exactly one tool call and nothing else.',
    tool: "delegate_task",
  },
  {
    id: "thread-read",
    prompt:
      "Read the thread thread-1 with the houston_thread_read tool. Make exactly one tool call " +
      "and nothing else.",
    tool: "houston_thread_read",
  },
  {
    id: "thread-search",
    prompt:
      "Search this environment's threads for gateway with the houston_thread_search tool. Make " +
      "exactly one tool call and nothing else.",
    tool: "houston_thread_search",
  },
];

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const template = (harness: Harness): Json => {
  const file = harness === "pi" ? "pi" : harness === "codex" ? "codex-local" : "opencode";
  const bytes = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "templates", `${file}.json.gz`),
  );
  return JSON.parse(NodeZlib.gunzipSync(bytes).toString("utf8")) as Json;
};

const options = () => {
  const values = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      values.set(arg.slice(2), value);
      index += 1;
    }
  }
  const harnesses = (values.get("harness") ?? "pi,codex,opencode")
    .split(",")
    .filter(
      (value): value is Harness => value === "pi" || value === "codex" || value === "opencode",
    );
  return {
    baseUrl: values.get("base-url") ?? "http://localhost:8888/v1",
    model: values.get("model") ?? "GLM-5.3-Flash",
    harnesses: harnesses.length === 0 ? (["pi", "codex", "opencode"] as const) : harnesses,
    samples: Number(values.get("samples") ?? "1"),
    out: values.get("out") ?? "runs/local-models",
    profile: values.get("tool-profile") === "lean" ? ("lean" as const) : ("full" as const),
  };
};

const toolDefinitions = (profile: "full" | "lean") =>
  visibleT3Tools({ links: true, profile }).map((tool) => ({
    name: tool.name.slice(HOUSTON_MCP_PREFIX.length),
    description: tool.description,
    input_schema: tool.input_schema,
  }));

const nativeInput = (value: unknown, prompt: string): ReadonlyArray<Json> => {
  const items = Array.isArray(value) ? value.filter(isRecord) : [];
  const withoutPrompt = items.filter((item) => !(item.type === "message" && item.role === "user"));
  return [
    ...withoutPrompt,
    { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
  ];
};

const piBody = (prompt: string, model: string, profile: "full" | "lean") => {
  const record = template("pi");
  const native =
    isRecord(record.request) && isRecord(record.request.provider_native)
      ? record.request.provider_native
      : {};
  const captured = {
    messages: Array.isArray(native.messages) ? native.messages : [],
    tools: Array.isArray(native.tools) ? native.tools : [],
    ...(typeof native.reasoning_effort === "string"
      ? { reasoning_effort: native.reasoning_effort }
      : {}),
  } satisfies PiTemplate;
  const tools = [
    ...piNativeTools(captured).map(chatTool),
    ...toolDefinitions(profile).map(chatTool),
  ];
  return {
    model,
    stream: false,
    messages: [
      { role: "system", content: piSystemPrompt(captured) },
      { role: "user", content: prompt },
    ],
    tools,
    ...(captured.reasoning_effort === undefined
      ? {}
      : { reasoning_effort: captured.reasoning_effort }),
  };
};

const codexBody = (prompt: string, model: string, profile: "full" | "lean") => {
  const record = template("codex");
  const native =
    isRecord(record.request) && isRecord(record.request.provider_native)
      ? record.request.provider_native
      : {};
  const capturedTools = Array.isArray(native.tools) ? native.tools : [];
  const tools = codexLocalTools(capturedTools, toolDefinitions(profile));
  return gatewayRequest({
    ...native,
    model,
    stream: false,
    tools,
    input: nativeInput(native.input, prompt),
  });
};

const openCodeRequest = (prompt: string, model: string) => {
  const record = template("opencode");
  const native =
    isRecord(record.request) && isRecord(record.request.provider_native)
      ? record.request.provider_native
      : {};
  const variants = isRecord(record.variants) ? record.variants : {};
  const variant = isRecord(variants["top+links"]) ? variants["top+links"] : {};
  const system = openCodeSystem(
    typeof variant.system === "string" ? variant.system : "",
    HOUSTON_ORCHESTRATION_INSTRUCTIONS.trim(),
    new Date().toISOString().slice(0, 10),
  );
  return {
    body: {
      ...native,
      model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    server: typeof record.mcpServer === "string" ? record.mcpServer : "houston",
    search: Array.isArray(variant.search)
      ? (variant.search as ReadonlyArray<OpenCodeSearchItem>)
      : [],
  };
};

const post = async (
  baseUrl: string,
  route: "chat/completions" | "responses",
  body: Json,
): Promise<{ readonly body: unknown; readonly wallMs: number }> => {
  const started = performance.now();
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} answered ${response.status}: ${text.slice(0, 500)}`);
  return { body: JSON.parse(text), wallMs: performance.now() - started };
};

const metricsOf = (body: unknown, wallMs: number): CallMetrics => {
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return {
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    cachedTokens: typeof details.cached_tokens === "number" ? details.cached_tokens : 0,
    ttft: reportedTtft(body),
    wallMs,
  };
};

const chatToolCalls = (body: unknown) => {
  const choice =
    isRecord(body) && isRecord(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
  return calls.map((call) => {
    const fn = isRecord(call.function) ? call.function : {};
    const raw = fn.arguments;
    let input: unknown = raw;
    if (typeof raw === "string") {
      try {
        input = JSON.parse(raw);
      } catch {
        input = raw;
      }
    }
    return { name: String(fn.name ?? ""), input };
  });
};

const responsesToolCalls = (body: unknown) =>
  (isRecord(body) && Array.isArray(body.output) ? body.output.filter(isRecord) : [])
    .filter((item) => item.type === "function_call")
    .map((item) => {
      let input: unknown = item.arguments;
      if (typeof item.arguments === "string") {
        try {
          input = JSON.parse(item.arguments);
        } catch {
          input = item.arguments;
        }
      }
      return { name: codexLocalCallName(item), input };
    });

const grade = (
  calls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
  expected: string,
  profile: "full" | "lean",
) => {
  const validity: Validity = emptyValidity();
  validity.calls = calls.length;
  if (calls.length === 0) noteInvalid(validity, "emptyReplies", "no tool call");
  let passed = false;
  for (const call of calls) {
    const tool = toolDefinitions(profile).find((candidate) => candidate.name === call.name);
    if (tool === undefined) {
      noteInvalid(validity, "unknownTool", call.name);
      continue;
    }
    if (!isRecord(call.input)) {
      noteInvalid(validity, "malformedJson", JSON.stringify(call.input));
      continue;
    }
    const problem = schemaProblem(tool.input_schema, call.input);
    if (problem !== undefined) {
      noteInvalid(validity, "schemaInvalid", `${call.name}: ${problem}`);
      continue;
    }
    if (call.name === expected) passed = true;
  }
  return { passed, validity };
};

const runOpenCode = async (
  request: ReturnType<typeof openCodeRequest>,
  baseUrl: string,
): Promise<ReadonlyArray<{ readonly name: string; readonly input: unknown }>> => {
  const { body } = await post(baseUrl, "chat/completions", request.body);
  const calls = chatToolCalls(body);
  const asked: Array<{ readonly name: string; readonly input: unknown }> = [];
  for (const call of calls) {
    if (call.name !== "execute" || !isRecord(call.input) || typeof call.input.code !== "string") {
      asked.push(call);
      continue;
    }
    const result = await executeOpenCode(call.input.code, {
      server: request.server,
      search: request.search,
      models: {},
      answer: async (name, input) => {
        asked.push({ name, input: openCodeInput(name, input) });
        return { value: { ok: true } };
      },
    });
    if (result.syntaxError) {
      asked.push({ name: "execute", input: { code: call.input.code, syntaxError: true } });
    }
  }
  return asked;
};

const run = async () => {
  const config = options();
  const model = config.model;
  NodeFS.mkdirSync(config.out, { recursive: true });
  const rows: Array<{
    readonly harness: Harness;
    readonly caseId: string;
    readonly pass: boolean;
    readonly error?: string;
    readonly calls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
    readonly validity?: Validity;
    readonly metrics: ReadonlyArray<CallMetrics>;
    readonly prefix?: { readonly gateway: string; readonly harness: string };
  }> = [];

  for (const harness of config.harnesses) {
    for (const evalCase of CASES) {
      for (let sample = 0; sample < config.samples; sample += 1) {
        try {
          if (harness === "pi") {
            const body = piBody(evalCase.prompt, model, config.profile);
            const answered = await post(config.baseUrl, "chat/completions", body);
            const toolCalls = chatToolCalls(answered.body);
            const graded = grade(toolCalls, evalCase.tool, config.profile);
            rows.push({
              harness,
              caseId: evalCase.id,
              pass: graded.passed,
              calls: toolCalls,
              validity: graded.validity,
              metrics: [metricsOf(answered.body, answered.wallMs)],
              prefix: staticPrefixHash("chat-completions", body),
            });
          } else if (harness === "codex") {
            const request = codexBody(evalCase.prompt, model, config.profile);
            const answered = await post(config.baseUrl, "responses", request.body);
            const restored = gatewayResponse(request.names, JSON.stringify(answered.body));
            const toolCalls = responsesToolCalls(restored);
            const graded = grade(toolCalls, evalCase.tool, config.profile);
            rows.push({
              harness,
              caseId: evalCase.id,
              pass: graded.passed,
              calls: toolCalls,
              validity: graded.validity,
              metrics: [metricsOf(answered.body, answered.wallMs)],
              prefix: staticPrefixHash("responses", request.body),
            });
          } else {
            const request = openCodeRequest(evalCase.prompt, model);
            const toolCalls = await runOpenCode(request, config.baseUrl);
            const graded = grade(toolCalls, evalCase.tool, config.profile);
            rows.push({
              harness,
              caseId: evalCase.id,
              pass: graded.passed,
              calls: toolCalls,
              validity: graded.validity,
              metrics: [],
              prefix: staticPrefixHash("chat-completions", request.body),
            });
          }
        } catch (error) {
          rows.push({
            harness,
            caseId: evalCase.id,
            pass: false,
            error: error instanceof Error ? error.message : String(error),
            calls: [],
            metrics: [],
          });
        }
      }
    }
  }

  const resultsFile = NodePath.join(config.out, "results.jsonl");
  NodeFS.writeFileSync(resultsFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const table = rows.map(
    (row) =>
      `${row.harness.padEnd(8)} ${row.caseId.padEnd(14)} ${row.pass ? "pass" : "fail"} ` +
      `${row.calls.map((call) => call.name).join(", ") || "-"}` +
      `${row.error === undefined ? "" : ` (${row.error})`}`,
  );
  process.stdout.write(`${table.join("\n")}\n\n`);
  for (const harness of config.harnesses) {
    const own = rows.filter((row) => row.harness === harness);
    process.stdout.write(
      `${harness}: ${own.filter((row) => row.pass).length}/${own.length} passed\n` +
        `${localSummary(own).join("\n")}\n\n`,
    );
  }
  process.stdout.write(`Wrote ${resultsFile}\n`);
};

await run();
