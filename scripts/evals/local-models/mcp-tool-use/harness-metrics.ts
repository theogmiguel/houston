// @effect-diagnostics nodeBuiltinImport:off
/**
 * Per-sample measurements beside the pass rate: whether tool calls were well formed, what each
 * model call cost in prompt tokens and time to first token, and how the harnesses' prompts differ.
 */
import * as NodeCrypto from "node:crypto";

import { inferenceStaticPrefix } from "./staticPrefix.ts";

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Tool-call validity for one sample, counted separately from whether the sample passed. */
export type Validity = {
  /** Tool calls the agent made, direct or from a code cell. */
  calls: number;
  /** Calls whose arguments were not a JSON object. */
  malformedJson: number;
  /** Calls to a tool the harness does not offer under that name or path. */
  unknownTool: number;
  /** Calls whose arguments the tool's schema rejects. */
  schemaInvalid: number;
  /** Code cells that did not parse. */
  codeErrors: number;
  /** Model replies with output tokens but no text and no tool call: the server dropped them. */
  emptyReplies: number;
  /** A few offending calls, for a person reading the results. */
  examples: Array<string>;
};

export const emptyValidity = (): Validity => ({
  calls: 0,
  malformedJson: 0,
  unknownTool: 0,
  schemaInvalid: 0,
  codeErrors: 0,
  emptyReplies: 0,
  examples: [],
});

export const noteInvalid = (
  validity: Validity,
  kind: "malformedJson" | "unknownTool" | "schemaInvalid" | "codeErrors" | "emptyReplies",
  example: string,
) => {
  validity[kind] += 1;
  if (validity.examples.length < 5) validity.examples.push(`${kind}: ${example.slice(0, 200)}`);
};

/** One model call as the server reported it. */
export type CallMetrics = {
  readonly promptTokens: number;
  readonly cachedTokens: number;
  /** Seconds, from the server's own timing when it reports one. */
  readonly ttft?: number | undefined;
  readonly wallMs: number;
};

/** Time to first token from an OpenAI-compatible response that reports it (tensorfold). */
export const reportedTtft = (body: unknown) => {
  const timing = isRecord(body) && isRecord(body.tensorfold) ? body.tensorfold : undefined;
  return typeof timing?.time_to_first_token === "number" ? timing.time_to_first_token : undefined;
};

/** Required keys and top-level types from a JSON schema; enough to catch a misshapen call. */
export const schemaProblem = (schema: unknown, input: unknown): string | undefined => {
  if (!isRecord(input)) return "arguments are not an object";
  if (!isRecord(schema)) return undefined;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof key === "string" && input[key] === undefined) return `missing ${key}`;
  }
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (property === undefined) {
      if (schema.additionalProperties === false) return `unknown key ${key}`;
      continue;
    }
    const type = isRecord(property) ? property.type : undefined;
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const expected = type === "integer" ? "number" : type;
    if (typeof expected === "string" && expected !== actual)
      return `${key} is ${actual}, not ${expected}`;
  }
  return undefined;
};

const sha = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * The gateway's static-prefix hash (system text and tools, as T3 hashes them for prompt cache
 * health) and the hash of everything before the case's first message.
 */
export const staticPrefixHash = (protocol: "chat-completions" | "responses", body: Json) => {
  const gateway = inferenceStaticPrefix(protocol, { ...body });
  const items = protocol === "responses" ? body.input : body.messages;
  const list = Array.isArray(items) ? items : [];
  const firstCase = list.findIndex(
    (item) =>
      isRecord(item) &&
      (item.role === "assistant" ||
        item.role === "tool" ||
        (item.role === "user" && !JSON.stringify(item).includes("<environment_context>"))),
  );
  const harness = JSON.stringify({
    tools: body.tools ?? null,
    instructions: body.instructions ?? null,
    head: firstCase === -1 ? list : list.slice(0, firstCase),
  });
  return { gateway: gateway === undefined ? "-" : sha(gateway), harness: sha(harness) };
};

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(textOf).join("\n")
      : isRecord(value) && typeof value.text === "string"
        ? value.text
        : isRecord(value) && value.content !== undefined
          ? textOf(value.content)
          : "";

/** The shape of one harness's first request for a case: what it sends before the case. */
export const harnessPrompt = (protocol: "chat-completions" | "responses", body: Json) => {
  const items = protocol === "responses" ? body.input : body.messages;
  const list = (Array.isArray(items) ? items : []).filter(isRecord);
  const system = list.filter((item) => item.role === "system" || item.role === "developer");
  const systemText = [textOf(body.instructions), ...system.map(textOf)].join("\n");
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter(isRecord);
  const flat = tools.flatMap((tool) =>
    tool.type === "namespace" && Array.isArray(tool.tools) ? tool.tools.filter(isRecord) : [tool],
  );
  const name = (tool: Json) =>
    String(tool.name ?? (isRecord(tool.function) ? tool.function.name : ""));
  const t3Direct = flat.map(name).filter((tool) => /t3[-_]code|^mcp__/.test(tool));
  return {
    systemChars: systemText.length,
    toolCount: flat.length,
    toolJsonChars: JSON.stringify(body.tools ?? []).length,
    t3DirectTools: t3Direct.length,
    t3NameExample: t3Direct.find((tool) => tool.endsWith("delegate_task")) ?? t3Direct[0] ?? "-",
    t3InstructionsPresent: systemText.includes("Houston orchestration"),
    reasoning:
      protocol === "responses"
        ? isRecord(body.reasoning)
          ? String(body.reasoning.effort ?? "-")
          : "-"
        : String(body.reasoning_effort ?? "-"),
    maxOutputTokens: String(body.max_completion_tokens ?? body.max_output_tokens ?? "-"),
  };
};

type Row = {
  readonly pass: boolean;
  readonly error?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly validity?: Validity | undefined;
  readonly metrics?: ReadonlyArray<CallMetrics> | undefined;
  readonly prefix?: { readonly gateway: string; readonly harness: string } | undefined;
};

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0
    ? Number.NaN
    : (sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN);
};
const round = (value: number, digits = 0) => (Number.isNaN(value) ? "-" : value.toFixed(digits));

/** The local-harness lines of a run summary: validity, prompt size, time to first token, prefixes. */
export const localSummary = (rows: ReadonlyArray<Row>) => {
  const finished = rows.filter((row) => row.error === undefined);
  const validity = finished.flatMap((row) => (row.validity ? [row.validity] : []));
  const total = (
    key:
      | "calls"
      | "malformedJson"
      | "unknownTool"
      | "schemaInvalid"
      | "codeErrors"
      | "emptyReplies",
  ) => validity.reduce((sum, entry) => sum + entry[key], 0);
  const invalidSamples = validity.filter(
    (entry) => entry.malformedJson + entry.unknownTool + entry.schemaInvalid + entry.codeErrors > 0,
  ).length;
  const metrics = finished.map((row) => row.metrics ?? []);
  const first = metrics.flatMap((calls) => (calls[0] ? [calls[0]] : []));
  const prompt = metrics.map((calls) => calls.reduce((sum, call) => sum + call.promptTokens, 0));
  const ttfts = metrics.flatMap((calls) =>
    calls.flatMap((call) => (call.ttft === undefined ? [] : [call.ttft])),
  );
  const firstTtft = first.flatMap((call) => (call.ttft === undefined ? [] : [call.ttft]));
  const count = (values: ReadonlyArray<string>) =>
    [...Map.groupBy(values, (value) => value)]
      .map(([value, list]) => `\`${value}\` ×${list.length}`)
      .join(", ");
  const maxSteps = finished.filter((row) => row.stopReason === "max_steps").length;
  return [
    `- Tool-call validity: ${total("calls")} calls in ${validity.length} samples; malformed JSON ${total("malformedJson")}, unknown tool ${total("unknownTool")}, schema-invalid ${total("schemaInvalid")}, code that did not parse ${total("codeErrors")}. Samples with any invalid call: ${invalidSamples}. Empty replies (output tokens, but no text or tool call): ${total("emptyReplies")}.`,
    `- Prompt tokens: first request ${round(mean(first.map((call) => call.promptTokens)))} mean; per sample ${round(mean(prompt))} mean over ${round(mean(metrics.map((calls) => calls.length)), 1)} model calls.`,
    ttfts.length === 0
      ? "- Time to first token: not reported by the server."
      : `- Time to first token (server-reported): first request median ${round(median(firstTtft), 2)} s, mean ${round(mean(firstTtft), 2)} s; all requests median ${round(median(ttfts), 2)} s.`,
    `- Ran out of steps: ${maxSteps} of ${finished.length} samples.`,
    `- Static prefix hashes (gateway, system and tools as T3 hashes them): ${count(finished.flatMap((row) => (row.prefix ? [row.prefix.gateway] : [])))}. Before the case's first message: ${count(finished.flatMap((row) => (row.prefix ? [row.prefix.harness] : [])))}.`,
  ];
};
