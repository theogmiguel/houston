import { assert, it } from "@effect/vitest";

import {
  codexLocalCall,
  codexLocalCallName,
  codexLocalTools,
  codexToolSchema,
  gatewayRequest,
  gatewayResponse,
} from "./codex-local.ts";
import { schemaProblem } from "./harness-metrics.ts";
import {
  executeOpenCode,
  openCodeInput,
  openCodePriorCall,
  openCodeSearch,
  type OpenCodeSearchItem,
} from "./opencode.ts";

it("declares MCP schemas the way Codex 0.167 does: kept keywords in its order, sorted properties", () => {
  assert.strictEqual(
    JSON.stringify(
      codexToolSchema({
        properties: {
          zeta: { maxLength: 9, type: "string", description: "z" },
          alpha: { type: "object" },
          list: { maxItems: 20, minItems: 1, type: "array", items: { type: "string" } },
        },
        type: "object",
        required: ["zeta"],
        additionalProperties: false,
      }),
    ),
    JSON.stringify({
      type: "object",
      properties: {
        alpha: { type: "object", properties: {} },
        list: { type: "array", items: { type: "string" }, minItems: 1 },
        zeta: { type: "string", description: "z" },
      },
      required: ["zeta"],
      additionalProperties: false,
    }),
  );
});

it("puts Houston's tools in Codex's namespaces, flattens them as the gateway does, and restores calls", () => {
  const tools = codexLocalTools(
    [
      { type: "function", name: "exec_command" },
      { type: "namespace", name: "mcp__houston", tools: [] },
      { type: "namespace", name: "mcp__houston_direct", tools: [] },
    ],
    [
      { name: "task_status", description: "Status.", input_schema: { type: "object" } },
      { name: "houston_thread_wait", description: "Wait.", input_schema: { type: "object" } },
      { name: "delegate_task", description: "Delegate.", input_schema: { type: "object" } },
    ],
  );
  const { body, names } = gatewayRequest({
    tools,
    input: [codexLocalCall("c0", "mcp__houston__task_status", { taskId: "t" })],
  });
  assert.deepStrictEqual(
    (body.tools as ReadonlyArray<{ readonly name: string }>).map((tool) => tool.name),
    [
      "exec_command",
      "mcp__houston__delegate_task",
      "mcp__houston__task_status",
      "mcp__houston_direct__houston_thread_wait",
    ],
  );
  assert.deepStrictEqual((body.input as ReadonlyArray<unknown>)[0], {
    type: "function_call",
    call_id: "c0",
    name: "mcp__houston__task_status",
    arguments: '{"taskId":"t"}',
  });
  const restored = gatewayResponse(
    names,
    JSON.stringify({
      output: [
        {
          type: "function_call",
          call_id: "c1",
          name: "mcp__houston_direct__houston_thread_wait",
          arguments: "{}",
        },
        { type: "function_call", call_id: "c2", name: "delegate_task", arguments: "{}" },
      ],
    }),
  ) as { readonly output: ReadonlyArray<Readonly<Record<string, unknown>>> };
  // A bare T3 name is not one Codex declared, so Codex answers it as an unsupported call.
  assert.deepStrictEqual(
    restored.output.map((item) => codexLocalCallName(item)),
    ["mcp__houston__houston_thread_wait", "delegate_task"],
  );
  assert.strictEqual(restored.output[0]?.namespace, "mcp__houston_direct");
});

const SERVER = "houston-x";
const SEARCH: ReadonlyArray<OpenCodeSearchItem> = [
  {
    path: `tools["${SERVER}"].delegate_task`,
    description: "Start one child agent.",
    signature: "",
  },
  { path: `tools["${SERVER}"].task_status`, description: "A delegate's status.", signature: "" },
  { path: "tools.opencode.worktree_list", description: "List worktrees.", signature: "" },
];

it("runs OpenCode Code Mode cells: T3 calls, search, errors and unknown tools", async () => {
  const asked: Array<unknown> = [];
  const run = (code: string) =>
    executeOpenCode(code, {
      server: SERVER,
      search: SEARCH,
      models: {},
      answer: async (name, input) => {
        asked.push([name, input]);
        return name === "task_status"
          ? { error: "No such task." }
          : { value: { taskId: "task-1" } };
      },
    });
  assert.deepStrictEqual(await run(`tools["${SERVER}"].delegate_task({ task: "x" })`), {
    output: '{\n  "taskId": "task-1"\n}',
    failed: false,
    unknownTools: [],
    syntaxError: false,
  });
  assert.strictEqual(
    (
      await run(
        `const r = await search({ query: "delegate" });\nreturn r.items.map((i) => i.path);`,
      )
    ).output,
    JSON.stringify([`tools["${SERVER}"].delegate_task`, `tools["${SERVER}"].task_status`], null, 2),
  );
  assert.deepStrictEqual(await run(`return await tools["${SERVER}"].task_status({})`), {
    output: "Error: No such task.",
    failed: true,
    unknownTools: [],
    syntaxError: false,
  });
  const unknown = await run(`await tools["${SERVER}"].delegate({ task: "x" })`);
  assert.deepStrictEqual(unknown.unknownTools, [`tools["${SERVER}"].delegate`]);
  assert.isTrue(unknown.failed);
  assert.isTrue((await run("return {")).syntaxError);
  // A dropped failing call and property probes neither call a tool nor crash the host.
  assert.isFalse(
    (await run(`tools["${SERVER}"].nope({}); return typeof tools["${SERVER}"].toString;`)).failed,
  );
  assert.strictEqual(
    (await run(`const ns = await tools["${SERVER}"]; return typeof ns;`)).output,
    "object",
  );
  assert.deepStrictEqual(asked, [
    ["delegate_task", { task: "x" }],
    ["task_status", {}],
  ]);
});

it("searches OpenCode's catalog by word, path matches first, within a namespace", () => {
  assert.deepStrictEqual(
    openCodeSearch(SEARCH, { query: "delegate status" }).items.map((item) => item.path),
    [`tools["${SERVER}"].task_status`, `tools["${SERVER}"].delegate_task`],
  );
  assert.deepStrictEqual(openCodeSearch(SEARCH, { namespace: "opencode" }).items.length, 1);
});

it("maps prior calls into OpenCode's tools and its arguments back for the graders", () => {
  assert.deepStrictEqual(openCodePriorCall(SERVER, "Bash", { command: "ls" }, undefined), {
    name: "shell",
    input: { command: "ls" },
  });
  assert.deepStrictEqual(openCodePriorCall(SERVER, "task_status", { taskId: "t" }, "task_status"), {
    name: "execute",
    input: { code: `return await tools["${SERVER}"].task_status({"taskId":"t"});` },
  });
  assert.deepStrictEqual(
    openCodeInput("edit", { filePath: "/a", oldString: "x", newString: "y" }),
    {
      file_path: "/a",
      old_string: "x",
      new_string: "y",
    },
  );
  assert.deepStrictEqual(openCodeInput("subagent", { agent: "general", prompt: "p" }), {
    prompt: "p",
    subagent_type: "general",
    run_in_background: false,
  });
});

it("checks required keys, simple types and closed objects of native tool calls", () => {
  const schema = {
    type: "object",
    properties: { command: { type: "string" }, timeout: { type: "integer" } },
    required: ["command"],
    additionalProperties: false,
  };
  assert.strictEqual(schemaProblem(schema, { command: "ls" }), undefined);
  assert.strictEqual(schemaProblem(schema, {}), "missing command");
  assert.strictEqual(
    schemaProblem(schema, { command: "ls", timeout: "5" }),
    "timeout is string, not number",
  );
  assert.strictEqual(schemaProblem(schema, { command: "ls", cwd: "/" }), "unknown key cwd");
});
