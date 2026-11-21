import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { TerminalShells } from "./terminalShells.ts";

const decode = Schema.decodeUnknownSync(TerminalShells);

describe("TerminalShells", () => {
  it("accepts a default shell and detected candidates", () => {
    expect(
      decode({
        defaultShell: "/bin/bash",
        candidates: [{ shell: "/bin/zsh", label: "Zsh" }],
      }),
    ).toEqual({
      defaultShell: "/bin/bash",
      candidates: [{ shell: "/bin/zsh", label: "Zsh" }],
    });
  });
});
