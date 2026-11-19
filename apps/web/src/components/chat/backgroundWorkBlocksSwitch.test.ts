import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { blockingBackgroundWorkOf } from "./backgroundWorkBlocksSwitch";

const failure = (error: unknown) => ({
  _tag: "Failure" as const,
  cause: Cause.fail(error),
});

describe("blockingBackgroundWorkOf", () => {
  it("reads the items a provider-switch refusal carries", () => {
    expect(
      blockingBackgroundWorkOf(
        failure({
          _tag: "OrchestrationV2DispatchCommandError",
          blockingBackgroundWork: [
            { kind: "command", description: "pnpm test", startedAt: "2026-11-18T12:00:00.000Z" },
          ],
        }),
      ),
    ).toEqual([
      { kind: "command", description: "pnpm test", startedAt: "2026-11-18T12:00:00.000Z" },
    ]);
  });

  it("ignores other dispatch failures and empty lists", () => {
    expect(
      blockingBackgroundWorkOf(
        failure({ _tag: "OrchestrationV2DispatchCommandError", message: "Offline" }),
      ),
    ).toBeNull();
    expect(
      blockingBackgroundWorkOf(
        failure({ _tag: "OrchestrationV2DispatchCommandError", blockingBackgroundWork: [] }),
      ),
    ).toBeNull();
  });

  it("ignores successful sends", () => {
    expect(blockingBackgroundWorkOf({ _tag: "Success", cause: Cause.empty })).toBeNull();
  });
});
