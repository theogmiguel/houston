// houston_defect_report: an agent in a project thread records a suspected defect; nothing leaves
// the machine. A side thread, harness review threads included, holds no T3 MCP credential.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  HoustonDefectReportResult,
  HoustonHarnessDefectDestination,
  HoustonHarnessError,
} from "@t3tools/contracts/houston/harnessReview";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { HoustonDefects } from "../defects/Defects.ts";

const ReportTool = Tool.make("houston_defect_report", {
  failure: Schema.Union([HoustonHarnessError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HoustonDefects,
  ],
  description:
    "Record a suspected defect in Houston or in this project, for the user to review. Stored redacted; nothing is sent anywhere.",
  parameters: Schema.Struct({
    title: Schema.String.annotate({ description: "1-120 characters." }),
    description: Schema.optional(Schema.String),
    evidence: Schema.optional(
      Schema.Array(Schema.String).annotate({
        description: "At most 10, each at most 500 characters.",
      }),
    ),
    destination: HoustonHarnessDefectDestination.annotate({
      description: "houston: a Houston defect; project: this project's.",
    }),
  }),
  success: HoustonDefectReportResult,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const HoustonDefectToolkit = Toolkit.make(ReportTool);
