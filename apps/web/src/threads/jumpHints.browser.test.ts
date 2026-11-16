import {
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingsConfig,
} from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { jumpHintLabels } from "./jumpHints";

const jumpBindings: ResolvedKeybindingsConfig = THREAD_JUMP_KEYBINDING_COMMANDS.map(
  (command, index) => ({
    command,
    shortcut: {
      key: String(index + 1),
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
  }),
);

describe("jumpHintLabels", () => {
  it("labels the first nine rows in order with distinct shortcuts", () => {
    const keys = Array.from({ length: 12 }, (_, index) => `env:t${index}`);
    const labels = jumpHintLabels(keys, jumpBindings);

    expect([...labels.keys()]).toEqual(keys.slice(0, 9));
    expect(new Set(labels.values()).size).toBe(9);
    expect(labels.get("env:t0")).toMatch(/1$/);
    expect(labels.get("env:t8")).toMatch(/9$/);
  });

  it("labels only as many rows as the rail has", () => {
    expect([...jumpHintLabels(["env:a", "env:b"], jumpBindings).keys()]).toEqual([
      "env:a",
      "env:b",
    ]);
  });

  it("labels nothing for an empty rail or a rail with no jump bindings", () => {
    expect(jumpHintLabels([], jumpBindings).size).toBe(0);
    expect(jumpHintLabels(["env:t0"], []).size).toBe(0);
  });
});
