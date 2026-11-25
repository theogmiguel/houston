import type { InferenceApiProtocol } from "@houston-app/contracts/houston/inference";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .toSorted()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

function staticPrefixOf(protocol: InferenceApiProtocol, body: Json) {
  switch (protocol) {
    case "chat-completions": {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const end = messages.findIndex(
        (message) =>
          !isRecord(message) || (message.role !== "system" && message.role !== "developer"),
      );
      return { system: end === -1 ? messages : messages.slice(0, end), tools: body.tools ?? null };
    }
    case "responses":
      return { instructions: body.instructions ?? null, tools: body.tools ?? null };
    case "messages":
      return { system: body.system ?? null, tools: body.tools ?? null };
    case "completions":
      return undefined;
  }
}

/** The canonical static prefix Houston's gateway hashes for prompt cache health. */
export const inferenceStaticPrefix = (protocol: InferenceApiProtocol, body: Json) => {
  const prefix = staticPrefixOf(protocol, body);
  return prefix === undefined ? undefined : canonicalJson(prefix);
};
