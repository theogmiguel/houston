#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/** A stdio MCP server for capture-local.ts: lists the tools in a JSON file and answers any call. */
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

type Json = Readonly<Record<string, unknown>>;
const tools: unknown = JSON.parse(NodeFS.readFileSync(process.argv[2] ?? "", "utf8"));
const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Json;
  if (message.id === undefined) return;
  const params = (message.params ?? {}) as Json;
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "houston", version: "0.0.0" },
        }
      : message.method === "tools/list"
        ? { tools }
        : message.method === "tools/call"
          ? { content: [{ type: "text", text: '{"ok":true}' }], structuredContent: { ok: true } }
          : {};
  send({ jsonrpc: "2.0", id: message.id, result });
});
