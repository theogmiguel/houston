import { assert, describe, it } from "@effect/vitest";

import { connectorCallReads } from "../src/houston/bots/toolRules.ts";
import { answer, STAND_IN_TOOLS } from "./dev-bot-connector.ts";

describe("the stand-in connector", () => {
  it("offers one tool that reads, one that writes and one with no verb", () => {
    assert.deepEqual(
      STAND_IN_TOOLS.map((tool) => [tool.name, connectorCallReads(tool.name)]),
      [
        ["search_items", true],
        ["send_item", false],
        ["frobnicate", false],
      ],
    );
  });

  it("records every call that reaches it and answers notifications with nothing", () => {
    const calls: Array<[string, unknown]> = [];
    const record = (tool: string, args: unknown) => calls.push([tool, args]);
    assert.deepInclude(answer({ id: 1, method: "initialize" }, record), { id: 1 });
    assert.isUndefined(answer({ method: "notifications/initialized" }, record));
    const listed = answer({ id: 2, method: "tools/list" }, record) as {
      readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
    };
    assert.lengthOf(listed.result.tools, 3);
    answer(
      { id: 3, method: "tools/call", params: { name: "send_item", arguments: { text: "x" } } },
      record,
    );
    assert.deepEqual(calls, [["send_item", { text: "x" }]]);
  });
});
