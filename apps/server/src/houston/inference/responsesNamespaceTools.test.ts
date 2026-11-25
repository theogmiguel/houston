import { describe, expect, it } from "vite-plus/test";

import { flattenNamespaceTools, makeResponseRestorer } from "./responsesNamespaceTools.ts";

const echo = {
  type: "function",
  name: "echo_x",
  description: "Echo",
  strict: false,
  parameters: { type: "object", properties: { x: { type: "string" } } },
};
const t3Tools = {
  type: "namespace",
  name: "mcp__t3_code",
  description: "Tools in the mcp__t3_code namespace.",
  tools: [echo],
};
const exec = { type: "function", name: "exec_command", parameters: {} };
const names = new Map([["mcp__t3_code__echo_x", { namespace: "mcp__t3_code", name: "echo_x" }]]);

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const run = (streaming: boolean, chunks: ReadonlyArray<string>) => {
  const restorer = makeResponseRestorer(names, streaming);
  const out = chunks.map((chunk) => decoder.decode(restorer.push(encoder.encode(chunk))));
  return out.join("") + decoder.decode(restorer.flush());
};

describe("flattenNamespaceTools", () => {
  it("flattens namespace tools and namespaced history calls", () => {
    const body = {
      model: "m",
      tools: [exec, t3Tools],
      input: [
        { type: "message", role: "user", content: "hi" },
        {
          type: "function_call",
          namespace: "mcp__t3_code",
          name: "echo_x",
          call_id: "c1",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "c1", output: "echoed" },
      ],
    };
    const flat = flattenNamespaceTools(body);
    expect(flat?.body).toEqual({
      model: "m",
      tools: [exec, { ...echo, name: "mcp__t3_code__echo_x" }],
      input: [
        body.input[0],
        { type: "function_call", name: "mcp__t3_code__echo_x", call_id: "c1", arguments: "{}" },
        body.input[2],
      ],
    });
    expect(flat?.names).toEqual(names);
  });

  it("keeps a long flat name within the function name limit and stable across requests", () => {
    const long = {
      ...echo,
      name: "a_tool_name_that_is_rather_long_for_the_sixty_four_character_limit",
    };
    const body = { tools: [{ ...t3Tools, tools: [long] }] };
    const [first] = [...(flattenNamespaceTools(body)?.names.keys() ?? [])];
    expect(first?.length).toBe(64);
    expect([...(flattenNamespaceTools(body)?.names.keys() ?? [])]).toEqual([first]);
    expect(flattenNamespaceTools(body)?.names.get(first ?? "")).toEqual({
      namespace: "mcp__t3_code",
      name: long.name,
    });
  });

  it("leaves requests without namespaces or with a colliding flat name untouched", () => {
    expect(flattenNamespaceTools({ tools: [exec], input: [] })).toBeUndefined();
    expect(
      flattenNamespaceTools({ tools: [{ ...exec, name: "mcp__t3_code__echo_x" }, t3Tools] }),
    ).toBeUndefined();
    expect(
      flattenNamespaceTools({
        tools: [
          t3Tools,
          { type: "namespace", name: "mcp", tools: [{ ...echo, name: "t3_code__echo_x" }] },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("makeResponseRestorer", () => {
  const flatCall = {
    type: "function_call",
    id: "fc_1",
    call_id: "c1",
    name: "mcp__t3_code__echo_x",
    arguments: '{"x":"hi"}',
  };
  const restoredCall = { ...flatCall, namespace: "mcp__t3_code", name: "echo_x" };

  it("restores the namespace on a non-streaming response's output", () => {
    const body = JSON.stringify({ id: "resp_1", output: [flatCall], usage: { input_tokens: 3 } });
    expect(JSON.parse(run(false, [body.slice(0, 20), body.slice(20)]))).toEqual({
      id: "resp_1",
      output: [restoredCall],
      usage: { input_tokens: 3 },
    });
  });

  it("restores SSE items across chunk boundaries and keeps other bytes exact", () => {
    const delta = `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"a"}\n\n`;
    const added = `event: response.output_item.added\r\ndata: ${JSON.stringify({ type: "response.output_item.added", item: flatCall })}\r\n\r\n`;
    const completed = `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [flatCall] } })}\n\n`;
    const stream = delta + added + completed;
    const cut = delta.length + added.indexOf("echo_x");
    const out = run(true, [
      stream.slice(0, cut),
      stream.slice(cut, cut + 7),
      stream.slice(cut + 7),
    ]);
    expect(out).toBe(
      delta +
        `event: response.output_item.added\r\ndata: ${JSON.stringify({ type: "response.output_item.added", item: restoredCall })}\r\n\r\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [restoredCall] } })}\n\n`,
    );
  });

  it("passes streams that never mention a namespace through byte for byte", () => {
    const stream = `data: {"type":"response.output_item.done","item":{"type":"function_call","name":"exec_command"}}\n\ndata: [DONE]`;
    expect(run(true, [stream.slice(0, 30), stream.slice(30)])).toBe(stream);
  });
});
