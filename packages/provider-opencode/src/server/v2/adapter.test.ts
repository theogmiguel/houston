import { describe, expect, it } from "vite-plus/test";

import { sessionRules } from "./adapter.ts";

const READ_ONLY = { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };

const lastFor = (rules: ReturnType<typeof sessionRules>, action: string) =>
  rules.findLast((rule) => rule.action === action || rule.action === "*");

describe("OpenCode 2 session rules", () => {
  it("a read-only sandbox denies shell and edit", () => {
    const grants = [{ action: "shell", resource: "git *", effect: "allow" as const }];
    const paths = [{ action: "edit", resource: "/plans/*", effect: "allow" as const }];
    for (const runtimeMode of ["full-access", "approval-required", "auto-accept-edits"] as const) {
      for (const interactionMode of ["default", "plan"] as const) {
        const rules = sessionRules(
          { runtimeMode, interactionMode, sandboxPolicy: READ_ONLY },
          paths,
          grants,
          "t3-code-thread",
        );
        const label = `${runtimeMode}/${interactionMode}`;
        expect(lastFor(rules, "shell")?.effect, label).toBe("deny");
        expect(lastFor(rules, "edit")?.effect, label).toBe("deny");
        expect(lastFor(rules, "subagent")?.effect, label).toBe("deny");
        expect(
          rules.some((rule) => rule.effect === "ask"),
          label,
        ).toBe(false);
        // Saved grants and plan paths cannot reopen a write.
        expect(rules.some((rule) => rule.effect === "allow" && rule.resource !== "*"), label).toBe(
          false,
        );
      }
    }

    // Without a sandbox, upstream's rules stay as they were.
    const plain = sessionRules(
      { runtimeMode: "approval-required", interactionMode: "default" },
      [],
      [],
      null,
    );
    expect(plain).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ]);
    expect(
      sessionRules({ runtimeMode: "full-access", interactionMode: "default" }, [], [], null),
    ).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  });
});
