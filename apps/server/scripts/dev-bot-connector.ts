#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off - A stdio stand-in for a connector, outside any runtime.
// A local stand-in connector for trying bot-thread rules: a stdio MCP server whose tools read,
// write and do something unnamed. Every call that reaches it is appended to the log file it is given.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

export const STAND_IN_TOOLS = [
  { name: "search_items", description: "Search the sample items by text." },
  { name: "send_item", description: "Send a sample item to someone." },
  { name: "frobnicate", description: "Frobnicate the sample items." },
].map((tool) => ({
  ...tool,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}));

type JsonRpcRequest = {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: { readonly name?: string; readonly arguments?: unknown };
};

/** The answer to one request, or undefined for a notification. */
export function answer(
  request: JsonRpcRequest,
  record: (tool: string, args: unknown) => void,
): object | undefined {
  if (request.id === undefined) return undefined;
  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "sample", version: "1.0.0" },
        },
      };
    case "tools/list":
      return { jsonrpc: "2.0", id: request.id, result: { tools: STAND_IN_TOOLS } };
    case "tools/call": {
      const tool = request.params?.name ?? "";
      record(tool, request.params?.arguments);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: `${tool} ran on the sample items.` }] },
      };
    }
    default:
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Unknown method ${request.method}` },
      };
  }
}

if (import.meta.main) {
  const logPath = process.argv[2];
  if (logPath === undefined) {
    console.error("Usage: node scripts/dev-bot-connector.ts <log file>");
    process.exit(64);
  }
  const record = (tool: string, args: unknown) =>
    NodeFS.appendFileSync(
      logPath,
      `${JSON.stringify({ at: new Date().toISOString(), tool, args })}\n`,
    );
  const lines = NodeReadline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    const reply = answer(JSON.parse(line) as JsonRpcRequest, record);
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
