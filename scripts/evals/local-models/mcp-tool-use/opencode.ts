// @effect-diagnostics nodeBuiltinImport:off
/**
 * OpenCode 2 on a server linked through Houston's gateway. OpenCode lists MCP tools only in its Code
 * Mode catalog: they run as JavaScript inside its `execute` tool, and the catalog shows the
 * cheapest few, so the rest are found with `search(...)`. A capture of real OpenCode supplies its
 * prompt, native tools, the catalog it rendered for Houston's tools and its search index.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeVM from "node:vm";

/** The T3 thread id the capture names its MCP server after: `houston-<thread id>`. */
export const OPENCODE_THREAD_ID = "00000000-0000-4000-8000-000000000001";

/** Which Houston tools the session lists: T3 hides some from children and from link-less sessions. */
export type OpenCodeVariant = { readonly subagent: boolean; readonly links: boolean };
export const openCodeVariantKey = ({ subagent, links }: OpenCodeVariant) =>
  `${subagent ? "child" : "top"}${links ? "+links" : ""}`;

/** Fingerprint of the Houston tools a capture served, so a stale template is caught. */
export const openCodeToolsHash = (
  tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: unknown;
    readonly inputSchema?: unknown;
  }>,
) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        tools.map(({ name, description, inputSchema }) => [name, description, inputSchema]),
      ),
    )
    .digest("hex")
    .slice(0, 16);

/** `tools.opencode.models` on a session linked to one served model, as the gateway sets it up. */
export const openCodeModels = (model: string) => ({
  providers: [
    {
      id: "houston-rtx",
      name: "rtx (Houston)",
      models: [
        {
          id: `houston-rtx/${model}`,
          name: model,
          released: 0,
          variants: [],
          cost: [],
          status: "active",
        },
      ],
    },
  ],
  total: 1,
  next: null,
});

export type OpenCodeSearchItem = {
  readonly path: string;
  readonly description: string;
  readonly signature: string;
};

/** OpenCode's native tools under the names the graders use. */
export const OPENCODE_TOOL_NAMES: Readonly<Record<string, string>> = {
  shell: "Bash",
  glob: "Glob",
  grep: "Grep",
  question: "AskUserQuestion",
  subagent: "Agent",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  skill: "Skill",
};

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The captured system prompt with Houston's instructions entry and the date filled in. */
export const openCodeSystem = (captured: string, instructions: string, date: string) =>
  captured.replace("{{HOUSTON_INSTRUCTIONS}}", instructions).replace("{{DATE}}", date);

/** A T3 call as code for OpenCode's `execute`. */
export const openCodeT3Code = (server: string, name: string, input: unknown) =>
  `return await tools[${JSON.stringify(server)}].${name}(${JSON.stringify(input ?? {})});`;

/** Claude-shaped prior calls in OpenCode's tools and argument shapes. */
export const openCodePriorCall = (
  server: string,
  name: string,
  input: unknown,
  t3Name: string | undefined,
): { readonly name: string; readonly input: unknown } => {
  if (t3Name !== undefined)
    return { name: "execute", input: { code: openCodeT3Code(server, t3Name, input) } };
  const args = isRecord(input) ? input : {};
  if (name === "Bash") return { name: "shell", input: { command: args.command } };
  if (name === "Read") return { name: "read", input: { filePath: args.file_path } };
  if (name === "Write")
    return { name: "write", input: { filePath: args.file_path, content: args.content } };
  if (name === "Edit")
    return {
      name: "edit",
      input: { filePath: args.file_path, oldString: args.old_string, newString: args.new_string },
    };
  return { name, input };
};

/** OpenCode-shaped arguments as the runner's graders and shell simulator read them. */
export const openCodeInput = (name: string, input: unknown) => {
  if (!isRecord(input)) return input;
  if ((name === "read" || name === "write" || name === "edit") && "filePath" in input) {
    const { filePath, oldString, newString, ...rest } = input;
    return {
      ...rest,
      file_path: filePath,
      ...(oldString === undefined ? {} : { old_string: oldString, new_string: newString }),
    };
  }
  if (name === "subagent") {
    const { agent, background, ...rest } = input;
    return { ...rest, subagent_type: agent, run_in_background: background === true };
  }
  return input;
};

/** A shell command for OpenCode's glob and grep, so the simulator answers them. */
export const openCodeSearchCommand = (name: string, input: Json) => {
  const path = typeof input.path === "string" ? input.path : ".";
  const pattern = JSON.stringify(String(input.pattern ?? ""));
  return name === "glob"
    ? `rg --files -g ${pattern} ${path}`
    : `rg -n ${pattern} ${path}${typeof input.include === "string" ? ` -g ${JSON.stringify(input.include)}` : ""}`;
};

/**
 * OpenCode's `search(...)`, approximated: an item matches when a query word is in its path or
 * description, path matches first. OpenCode's own ranking is not reproduced.
 */
export const openCodeSearch = (items: ReadonlyArray<OpenCodeSearchItem>, input: unknown) => {
  const args = isRecord(input) ? input : {};
  const words = String(args.query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  const namespace = typeof args.namespace === "string" ? args.namespace : undefined;
  const inNamespace = (path: string) =>
    namespace === undefined ||
    path.startsWith(`tools[${JSON.stringify(namespace)}]`) ||
    path.startsWith(`tools.${namespace}.`);
  const score = (item: OpenCodeSearchItem) =>
    words.length === 0
      ? 1
      : words.reduce(
          (sum, word) =>
            sum +
            (item.path.toLowerCase().includes(word) ? 2 : 0) +
            (item.description.toLowerCase().includes(word) ? 1 : 0),
          0,
        );
  const matched = items
    .filter((item) => inNamespace(item.path))
    .map((item) => ({ item, score: score(item) }))
    .filter(({ score: value }) => value > 0)
    .toSorted((a, b) => b.score - a.score)
    .map(({ item }) => item);
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const limit = typeof args.limit === "number" ? args.limit : 10;
  const page = matched.slice(offset, offset + limit);
  const remaining = Math.max(0, matched.length - offset - page.length);
  return { items: page, remaining, next: remaining > 0 ? { offset: offset + page.length } : null };
};

/** What one `execute` call did, for the validity counts. */
export type OpenCodeExecution = {
  readonly output: string;
  readonly failed: boolean;
  /** Tool paths the code called that the catalog does not have. */
  readonly unknownTools: ReadonlyArray<string>;
  /** The code did not parse. */
  readonly syntaxError: boolean;
};

const resultText = (value: unknown) =>
  value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

/**
 * Runs an `execute` cell. `tools[<T3 server>].<name>` calls go to `answer`; OpenCode's own
 * namespaces return an empty result. Only serialized data crosses into the sandbox.
 */
export const executeOpenCode = async (
  code: string,
  options: {
    readonly server: string;
    readonly search: ReadonlyArray<OpenCodeSearchItem>;
    /** What `tools.opencode.models` lists: the linked server's model. */
    readonly models: unknown;
    /** A T3 call's result, or the error OpenCode raises in the cell for a failed call. */
    readonly answer: (
      name: string,
      input: unknown,
    ) => Promise<{ readonly value: unknown } | { readonly error: string }>;
  },
): Promise<OpenCodeExecution> => {
  const known = new Set(options.search.map((item) => item.path));
  const unknownTools: Array<string> = [];
  const pending: Array<{ path: string; input: string; resolve: (value: string) => void }> = [];
  const bridge = Object.setPrototypeOf(
    (path: string, input: string, resolve: (value: string) => void) =>
      pending.push({ path, input, resolve }),
    null,
  );
  const context = NodeVM.createContext(
    { __bridge: bridge, __known: JSON.stringify([...known]) },
    { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
  );
  const run = (source: string) => NodeVM.runInContext(source, context, { timeout: 250 });
  run(`((bridge, known) => {
    delete globalThis.__bridge; delete globalThis.__known;
    // A cell may drop a failed call's promise; marking it handled keeps the host process alive.
    const call = (path) => (input) => { const p = new Promise((resolve, reject) => bridge(path, JSON.stringify(input ?? {}), (reply) => { const r = JSON.parse(reply); if ("error" in r) reject(new Error(r.error)); else resolve(r.value); })); p.catch(() => {}); return p; };
    // Not tool names: \`await tools.x\` must not see a \`then\`, and String(tools.x) must not call.
    const plain = new Set(["then", "toString", "valueOf", "toJSON", "constructor"]);
    const namespace = (prefix) => new Proxy({}, { get: (_, name) => typeof name === "string" && !plain.has(name) ? call(prefix + "." + name) : undefined });
    globalThis.tools = new Proxy({}, { get: (_, ns) => typeof ns !== "string" || plain.has(ns) ? undefined : namespace(/^[A-Za-z_$][\\w$]*$/.test(ns) ? "tools." + ns : "tools[" + JSON.stringify(ns) + "]") });
    globalThis.search = (input) => call("search")(input);
    globalThis.__result = undefined; globalThis.__error = undefined; globalThis.__done = false;
  })(__bridge, JSON.parse(__known));`);
  // OpenCode returns the last expression when the code has no `return`; a lone expression is
  // the common case, so it is tried as one first.
  const wrapped = (body: string) =>
    `(async () => { ${body}\n })().then((value) => { __result = value === undefined ? undefined : JSON.stringify(value); __done = true; }, (error) => { __error = String(error && error.message || error); __done = true; });`;
  // Errors from the sandbox come from its own realm, so they are told apart by name.
  const syntaxError = (error: unknown) => isRecord(error) && error.name === "SyntaxError";
  try {
    try {
      run(wrapped(`return (${code.trim().replace(/;\s*$/, "")});`));
    } catch (error) {
      if (!syntaxError(error)) throw error;
      run(wrapped(code));
    }
  } catch (error) {
    if (syntaxError(error)) {
      const message = isRecord(error) ? String(error.message) : "";
      return { output: `SyntaxError: ${message}`, failed: true, unknownTools, syntaxError: true };
    }
    throw error;
  }
  for (let count = 0; !context.__done || pending.length > 0; count++) {
    if (count === 128) throw new Error("Code cell exceeded 128 tool calls.");
    const job = pending.shift();
    if (!job) throw new Error("Code cell stalled without a tool call.");
    const input: unknown = JSON.parse(job.input);
    let reply: { readonly value: unknown } | { readonly error: string };
    if (job.path === "search") reply = { value: openCodeSearch(options.search, input) };
    else if (!known.has(job.path)) {
      unknownTools.push(job.path);
      reply = { error: `${job.path} is not a function` };
    } else if (job.path.startsWith(`tools[${JSON.stringify(options.server)}].`)) {
      reply = await options.answer(job.path.slice(job.path.lastIndexOf(".") + 1), input);
    } else if (job.path === "tools.opencode.models") {
      reply = { value: options.models };
    } else reply = { value: {} };
    context.__resolve = job.resolve;
    context.__reply = JSON.stringify("value" in reply ? { value: reply.value ?? null } : reply);
    run("__resolve(__reply); delete globalThis.__resolve; delete globalThis.__reply;");
  }
  if (context.__error !== undefined) {
    return {
      output: `Error: ${String(context.__error)}`,
      failed: true,
      unknownTools,
      syntaxError: false,
    };
  }
  const value =
    context.__result === undefined ? undefined : (JSON.parse(String(context.__result)) as unknown);
  return { output: resultText(value), failed: false, unknownTools, syntaxError: false };
};
