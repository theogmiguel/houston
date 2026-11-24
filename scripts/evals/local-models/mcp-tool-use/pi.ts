/**
 * Pi on an OpenAI-compatible server, such as a local GLM. A capture of the request Pi sends with
 * Houston's bridge loaded supplies Pi's prompt and native tools; Houston's section and tools come from this
 * checkout. The bridge eagerly declares every T3 tool for `openai-completions` models, so they are
 * all direct here too.
 */
import { HOUSTON_ORCHESTRATION_INSTRUCTIONS } from "@houston-app/provider-core/server/orchestrationInstructions";

export const OPENAI_COMPATIBLE_PREFIX = "openai-compatible:";
export type OpenAiCompatibleModel = `openai-compatible:${string}`;
export const isOpenAiCompatible = (model: string): model is OpenAiCompatibleModel =>
  model.startsWith(OPENAI_COMPATIBLE_PREFIX);
/** The model id the server knows. */
export const servedModel = (model: OpenAiCompatibleModel) =>
  model.slice(OPENAI_COMPATIBLE_PREFIX.length);

/** Pi's native tools under the names the graders use. */
export const PI_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  tool_search: "ToolSearch",
};

type Block = { readonly type: string; readonly [key: string]: unknown };
type ApiMessage = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type ApiTool = {
  readonly name: string;
  readonly description?: unknown;
  readonly input_schema?: unknown;
};
export type ChatTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
};
export type PiTemplate = {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
  readonly tools: ReadonlyArray<{
    readonly function: {
      readonly name: string;
      readonly description?: string | undefined;
      readonly parameters?: unknown;
    };
  }>;
  readonly reasoning_effort?: string | undefined;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

const SECTION = /<houston_orchestration>\n[\s\S]*?\n<\/houston_orchestration>/;
export const PI_CWD = "/home/user/app";

/** Pi's system prompt with Houston's section from this checkout, as the bridge adds it. */
export const piSystemPrompt = (template: PiTemplate) => {
  const system = template.messages.find(
    (message) => message.role === "developer" || message.role === "system",
  );
  const text = valueText(system?.content);
  if (!SECTION.test(text)) {
    throw new Error("The Pi template needs Pi's <houston_orchestration> section.");
  }
  return text
    .replace(
      SECTION,
      `<houston_orchestration>\n${HOUSTON_ORCHESTRATION_INSTRUCTIONS.trim()}\n</houston_orchestration>`,
    )
    .replace(/<cwd>\n.*\n<\/cwd>/, `<cwd>\n${PI_CWD}\n</cwd>`);
};

/** The bridge's jsonSchemaToTypebox: zero-argument tools still declare `properties`. */
export const piParameters = (schema: unknown) => {
  const record = isRecord(schema) ? schema : {};
  return {
    ...record,
    type: record.type ?? "object",
    ...(record.properties === undefined ? { properties: {} } : {}),
  };
};

export const chatTool = (tool: ApiTool): ChatTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: valueText(tool.description ?? tool.name),
    parameters: piParameters(tool.input_schema),
  },
});

/** Native tools from the capture, as ApiTools so prior calls and graders can find them. */
export const piNativeTools = (template: PiTemplate) =>
  template.tools
    .filter((tool) => !tool.function.name.startsWith("mcp__"))
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      input_schema: tool.function.parameters,
    }));

/** Claude-shaped prior file calls in Pi's argument shapes. */
const piInput = (name: string, input: unknown) => {
  if (!isRecord(input) || typeof input.file_path !== "string") return input;
  const path = input.file_path;
  if (name === "read") return { path };
  if (name === "write") return { path, content: input.content };
  if (name === "edit")
    return { path, edits: [{ oldText: input.old_string, newText: input.new_string }] };
  return input;
};

/** How a harness replays one tool call and its result; Pi's by default. */
export type ChatReplay = {
  readonly call: (id: string, name: string, input: unknown) => { name: string; input: unknown };
  readonly result: (id: string, content: string) => string;
};
const PI_REPLAY: ChatReplay = {
  call: (_, name, input) => ({ name, input: piInput(name, input) }),
  result: (_, content) => content,
};

/** The runner's Anthropic-shaped transcript as chat completion messages. */
export const chatMessages = (messages: ReadonlyArray<ApiMessage>, replay: ChatReplay = PI_REPLAY) =>
  messages.flatMap((message): Array<Record<string, unknown>> => {
    if (message.role === "assistant") {
      const thinking = message.content.filter((block) => block.type === "thinking");
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => valueText(block.text))
        .join("");
      const calls = message.content.filter((block) => block.type === "tool_use");
      return [
        {
          role: "assistant",
          ...(text ? { content: text } : {}),
          ...(thinking.length > 0
            ? {
                [valueText(thinking[0]!.field) || "reasoning_content"]: thinking
                  .map((block) => valueText(block.thinking))
                  .join("\n"),
              }
            : {}),
          ...(calls.length > 0
            ? {
                tool_calls: calls.map((block) => {
                  const call = replay.call(valueText(block.id), valueText(block.name), block.input);
                  return {
                    id: block.id,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  };
                }),
              }
            : {}),
        },
      ];
    }
    const results = message.content
      .filter((block) => block.type === "tool_result")
      .map((block) => ({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: replay.result(valueText(block.tool_use_id), valueText(block.content)),
      }));
    const texts = message.content
      .filter((block) => block.type === "text")
      .map((block) => ({ type: "text", text: valueText(block.text) }));
    return [...results, ...(texts.length > 0 ? [{ role: "user", content: texts }] : [])];
  });

const parseArguments = (raw: unknown) => {
  if (typeof raw !== "string") return isRecord(raw) ? raw : {};
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return isRecord(parsed) ? parsed : { arguments: raw };
  } catch {
    return { arguments: raw };
  }
};

/** One chat completion as the runner's Anthropic-shaped response. */
export const fromChatCompletion = (response: unknown) => {
  const body = isRecord(response) ? response : {};
  const choice = Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const field = ["reasoning_content", "reasoning", "reasoning_text"].find(
    (key) => typeof message[key] === "string" && message[key] !== "",
  );
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
  const content: Array<Block> = [
    ...(field ? [{ type: "thinking", thinking: message[field], field }] : []),
    ...(typeof message.content === "string" && message.content !== ""
      ? [{ type: "text", text: message.content }]
      : []),
    ...calls.map((call) => {
      const fn = isRecord(call.function) ? call.function : {};
      const input = parseArguments(fn.arguments);
      return {
        type: "tool_use",
        id: valueText(call.id),
        name: valueText(fn.name),
        input,
        // Arguments that are not a JSON object reach the tool as `{ arguments: <raw> }`.
        ...(isRecord(input) &&
        Object.keys(input).length === 1 &&
        typeof input.arguments === "string" &&
        typeof fn.arguments === "string" &&
        fn.arguments.trim() !== "" &&
        input.arguments === fn.arguments
          ? { malformed: true }
          : {}),
      };
    }),
  ];
  const usage = isRecord(body.usage) ? body.usage : {};
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  return {
    content,
    stop_reason:
      calls.length > 0 ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn",
    usage: {
      input_tokens: prompt - cached,
      output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      cache_read_input_tokens: cached,
    },
  };
};
