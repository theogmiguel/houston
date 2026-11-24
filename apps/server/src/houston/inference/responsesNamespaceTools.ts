/**
 * Codex sends MCP tools as Responses `namespace` tools, which servers that run function tools only
 * reject. These are flattened to `<namespace>__<name>` function tools on the way up, and calls to
 * them are given back their `namespace` on the way down, as the Responses API represents them.
 */

export interface NamespacedName {
  readonly namespace: string;
  readonly name: string;
}

/** Flat name to the namespaced tool it stands for, for one request. */
export type NamespaceNames = ReadonlyMap<string, NamespacedName>;

const SEPARATOR = "__";
// OpenAI's limit on function names; longer flat names keep a stable hash so history still maps.
const MAX_NAME_LENGTH = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const flatName = (namespace: string, name: string) => {
  const full = `${namespace}${SEPARATOR}${name}`;
  if (full.length <= MAX_NAME_LENGTH) return full;
  let fnv = 0x811c9dc5;
  for (let index = 0; index < full.length; index += 1) {
    fnv = Math.imul(fnv ^ full.charCodeAt(index), 0x01000193) >>> 0;
  }
  const hash = fnv.toString(16).padStart(8, "0");
  return `${full.slice(0, MAX_NAME_LENGTH - hash.length - 1)}_${hash}`;
};

/**
 * The body to send instead, or undefined to send it as is: when it has no namespaces, or when a
 * flat name would collide and the server should answer the original.
 */
export function flattenNamespaceTools(
  body: Record<string, unknown>,
): { readonly body: Record<string, unknown>; readonly names: NamespaceNames } | undefined {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const input = Array.isArray(body.input) ? body.input : [];
  const names = new Map<string, NamespacedName>();
  const taken = new Set<string>();
  for (const tool of tools) {
    if (isRecord(tool) && tool.type !== "namespace" && typeof tool.name === "string") {
      taken.add(tool.name);
    }
  }
  let collides = false;
  const claim = (namespace: string, name: string) => {
    const flat = flatName(namespace, name);
    const known = names.get(flat);
    if (taken.has(flat) || (known && (known.namespace !== namespace || known.name !== name))) {
      collides = true;
    }
    names.set(flat, { namespace, name });
    return flat;
  };

  const flatTools = tools.flatMap((tool) => {
    if (!isRecord(tool) || tool.type !== "namespace" || typeof tool.name !== "string") {
      return [tool];
    }
    const namespace = tool.name;
    return (Array.isArray(tool.tools) ? tool.tools : []).map((inner) =>
      isRecord(inner) && inner.type === "function" && typeof inner.name === "string"
        ? { ...inner, name: claim(namespace, inner.name) }
        : inner,
    );
  });
  const flatInput = input.map((item) => {
    if (
      !isRecord(item) ||
      item.type !== "function_call" ||
      typeof item.namespace !== "string" ||
      typeof item.name !== "string"
    ) {
      return item;
    }
    const { namespace, ...rest } = item;
    return { ...rest, name: claim(namespace, item.name) };
  });
  if (names.size === 0 || collides) return undefined;
  return {
    body: {
      ...body,
      ...(Array.isArray(body.tools) ? { tools: flatTools } : {}),
      ...(Array.isArray(body.input) ? { input: flatInput } : {}),
    },
    names,
  };
}

const restoreCall = (names: NamespaceNames, item: unknown): unknown => {
  if (!isRecord(item) || item.type !== "function_call" || typeof item.name !== "string") {
    return item;
  }
  const original = names.get(item.name);
  return original === undefined ? item : { ...item, ...original };
};

const restoreOutput = (names: NamespaceNames, response: unknown): unknown =>
  isRecord(response) && Array.isArray(response.output)
    ? { ...response, output: response.output.map((item) => restoreCall(names, item)) }
    : response;

/** One SSE event or a whole non-streaming response, with its namespaced calls restored. */
function restoreEvent(names: NamespaceNames, event: unknown): unknown {
  if (!isRecord(event)) return event;
  if (Array.isArray(event.output)) return restoreOutput(names, event);
  let restored = event;
  if (isRecord(event.item)) restored = { ...restored, item: restoreCall(names, event.item) };
  if (isRecord(event.response)) {
    restored = { ...restored, response: restoreOutput(names, event.response) };
  }
  if (typeof event.name === "string" && typeof event.type === "string") {
    const original = names.get(event.name);
    if (original !== undefined && event.type.startsWith("response.function_call")) {
      restored = { ...restored, ...original };
    }
  }
  return restored;
}

const EMPTY = new Uint8Array(0);
const DATA_PREFIX = /^data: ?/;

export interface ResponseRestorer {
  readonly push: (chunk: Uint8Array) => Uint8Array;
  /** The bytes still held once the upstream body ends. */
  readonly flush: () => Uint8Array;
}

/**
 * Rewrites only SSE `data:` lines that mention a flattened namespace and passes every other byte
 * through. A line split across chunks is held until its newline arrives.
 */
export function makeResponseRestorer(names: NamespaceNames, streaming: boolean): ResponseRestorer {
  const markers = [...new Set([...names.values()].map(({ namespace }) => namespace + SEPARATOR))];
  const mentions = (bytes: Buffer) => markers.some((marker) => bytes.includes(marker));
  let pending: Buffer = Buffer.alloc(0);

  const rewriteJson = (text: string): string | undefined => {
    try {
      return JSON.stringify(restoreEvent(names, JSON.parse(text)));
    } catch {
      return undefined;
    }
  };

  const rewriteLines = (block: Buffer): Uint8Array => {
    if (!mentions(block)) return block;
    const parts: Array<Buffer> = [];
    let offset = 0;
    while (offset < block.length) {
      const newline = block.indexOf(10, offset);
      const end = newline === -1 ? block.length : newline + 1;
      const line = block.subarray(offset, end);
      offset = end;
      const text = line.toString("utf8");
      const prefix = DATA_PREFIX.exec(text)?.[0];
      if (prefix === undefined || !mentions(line)) {
        parts.push(line);
        continue;
      }
      const tail = /\r?\n?$/.exec(text)![0];
      const json = rewriteJson(text.slice(prefix.length, text.length - tail.length));
      parts.push(json === undefined ? line : Buffer.from(`${prefix}${json}${tail}`, "utf8"));
    }
    return Buffer.concat(parts);
  };

  const push = (chunk: Uint8Array): Uint8Array => {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const data = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
    if (!streaming) {
      pending = Buffer.from(data);
      return EMPTY;
    }
    const end = data.lastIndexOf(10);
    pending = Buffer.from(data.subarray(end + 1));
    return end === -1 ? EMPTY : rewriteLines(data.subarray(0, end + 1));
  };

  const flush = (): Uint8Array => {
    const rest = pending;
    pending = Buffer.alloc(0);
    if (rest.length === 0) return EMPTY;
    if (streaming) return rewriteLines(rest);
    if (!mentions(rest)) return rest;
    const json = rewriteJson(rest.toString("utf8"));
    return json === undefined ? rest : Buffer.from(json, "utf8");
  };

  return { push, flush };
}
