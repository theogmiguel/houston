/**
 * Codex on a server linked through Houston's inference gateway. Codex declares Houston's MCP tools as
 * Responses `namespace` tools; the gateway flattens them to function tools on the way up and gives
 * calls back their namespace on the way down. Both steps use the gateway's own code.
 */
import {
  flattenNamespaceTools,
  makeResponseRestorer,
  type NamespaceNames,
} from "./namespaceTools.ts";

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Codex's namespaces for Houston's two MCP registrations (CodexAdapterV2). */
export const CODEX_T3_NAMESPACE = "mcp__houston";
export const CODEX_T3_DIRECT_NAMESPACE = "mcp__houston_direct";
/** The tool T3 registers only on its direct server. */
const DIRECT_ONLY = new Set(["houston_thread_wait"]);
/** How the runner names a T3 call made through either namespace. */
export const codexLocalT3Name = (name: string) => `${CODEX_T3_NAMESPACE}__${name}`;

// Codex keeps these schema keywords, in this order, and sorts properties. Checked against a
// capture of Codex 0.167 declaring all of Houston's tools.
const SCHEMA_KEYS = [
  "type",
  "description",
  "enum",
  "items",
  "minItems",
  "properties",
  "required",
  "additionalProperties",
  "anyOf",
] as const;

/** An MCP input schema as Codex declares it. Objects always get `properties`. */
export const codexToolSchema = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(codexToolSchema);
  if (!isRecord(schema)) return schema;
  const source =
    schema.type === "object" && schema.properties === undefined
      ? { ...schema, properties: {} }
      : schema;
  const result: Record<string, unknown> = {};
  for (const key of SCHEMA_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    result[key] =
      key === "properties" && isRecord(value)
        ? Object.fromEntries(
            Object.keys(value)
              .toSorted()
              .map((name) => [name, codexToolSchema(value[name])]),
          )
        : codexToolSchema(value);
  }
  return result;
};

/** Houston tools by bare name, as the runner holds them. */
type T3Tool = {
  readonly name: string;
  readonly description?: unknown;
  readonly input_schema?: unknown;
};

/** The captured tools with Houston's tools from this checkout in Codex's namespaces, sorted by name. */
export const codexLocalTools = (
  captured: ReadonlyArray<unknown>,
  t3: ReadonlyArray<T3Tool>,
): ReadonlyArray<unknown> => {
  const declared = (direct: boolean) =>
    t3
      .filter((tool) => DIRECT_ONLY.has(tool.name) === direct)
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((tool) => ({
        type: "function",
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        strict: false,
        parameters: codexToolSchema(tool.input_schema),
      }));
  return captured.map((tool) =>
    isRecord(tool) && tool.type === "namespace"
      ? {
          ...tool,
          tools: declared(tool.name === CODEX_T3_DIRECT_NAMESPACE),
        }
      : tool,
  );
};

/** What Houston's gateway sends upstream for a body Codex sent, and the names it must restore. */
export const gatewayRequest = (
  body: Json,
): { readonly body: Json; readonly names: NamespaceNames } => {
  const flat = flattenNamespaceTools({ ...body });
  return flat === undefined ? { body, names: new Map() } : flat;
};

/** The upstream response as Codex gets it back from the gateway. */
export const gatewayResponse = (names: NamespaceNames, raw: string): unknown => {
  if (names.size === 0) return JSON.parse(raw);
  const restorer = makeResponseRestorer(names, false);
  restorer.push(new TextEncoder().encode(raw));
  return JSON.parse(new TextDecoder().decode(restorer.flush()));
};

/** A function call as Codex replays it: T3 calls carry their namespace. */
export const codexLocalCall = (callId: string, name: string, args: unknown) => {
  const bare = name.startsWith(`${CODEX_T3_NAMESPACE}__`)
    ? name.slice(CODEX_T3_NAMESPACE.length + 2)
    : undefined;
  return {
    type: "function_call",
    call_id: callId,
    ...(bare === undefined
      ? { name }
      : {
          namespace: DIRECT_ONLY.has(bare) ? CODEX_T3_DIRECT_NAMESPACE : CODEX_T3_NAMESPACE,
          name: bare,
        }),
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  };
};

/** The runner's name for a call in a response: namespaced T3 calls get one T3 prefix. */
export const codexLocalCallName = (item: Json) =>
  typeof item.namespace === "string" &&
  (item.namespace === CODEX_T3_NAMESPACE || item.namespace === CODEX_T3_DIRECT_NAMESPACE)
    ? codexLocalT3Name(String(item.name))
    : String(item.name);

/**
 * Tool output as Codex 0.167 words it for the model, from the capture: MCP results get a wall
 * time, exec_command results also a chunk id, exit code and token count.
 */
export const codexLocalOutput = (name: string, output: string, failed: boolean) =>
  name.startsWith(`${CODEX_T3_NAMESPACE}__`)
    ? `Wall time: 0.0000 seconds\nOutput:\n${output}`
    : name === "exec_command"
      ? `Chunk ID: 000001\nWall time: 0.0000 seconds\nProcess exited with code ${
          failed ? (/^Exit code (\d+)/.exec(output)?.[1] ?? "1") : "0"
        }\nOriginal token count: ${Math.ceil(output.length / 4)}\nOutput:\n${output.replace(/^Exit code \d+\n?/, "")}\n`
      : output;

/** Claude-shaped prior shell and file calls as Codex's exec_command. */
export const codexLocalPriorInput = (
  name: string,
  input: unknown,
): { name: string; input: unknown } => {
  const args = isRecord(input) ? input : {};
  if (name === "Bash") return { name: "exec_command", input: { cmd: args.command } };
  if (name === "Read" || name === "Write" || name === "Edit") {
    const file = JSON.stringify(String(args.file_path ?? ""));
    const cmd =
      name === "Read"
        ? `cat ${file}`
        : name === "Write"
          ? `cat > ${file} <<'EVAL_EOF'\n${String(args.content ?? "")}\nEVAL_EOF`
          : `python3 -c ${JSON.stringify(`from pathlib import Path; p=Path(${file}); p.write_text(p.read_text().replace(${JSON.stringify(args.old_string)}, ${JSON.stringify(args.new_string)}))`)}`;
    return { name: "exec_command", input: { cmd } };
  }
  return { name, input };
};
