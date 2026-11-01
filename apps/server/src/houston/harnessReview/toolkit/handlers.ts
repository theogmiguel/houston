// The calling thread's project owns the defect; a side thread is refused before anything is stored.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { loadCaller } from "../../../mcp/threadAccess.ts";
import { HoustonDefects } from "../defects/Defects.ts";
import { HoustonDefectToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HoustonDefectToolkit, {
  houston_defect_report: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const tool = "houston_defect_report";
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadScope = yield* McpInvocationContext.requireThreadScope(scope, tool);
      const { caller } = yield* loadCaller();
      const threadId = threadScope.thread.threadId;
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: "The calling thread was not found.",
        });
      }
      if (caller.side !== undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `thread ${threadId} is a side thread, which is read-only; ${tool} records defects from project threads only`,
        });
      }
      return yield* (yield* HoustonDefects).report({
        projectId: caller.projectId,
        threadId,
        title: input.title,
        description: input.description,
        evidence: input.evidence,
        destination: input.destination,
      });
    }),
  ),
});
