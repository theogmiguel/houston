import type { EnvironmentId } from "@houston-app/contracts";
import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import {
  V1_IMPORT_EMPTY_INPUT,
  v1SlackImportRun,
  v1SlackImportStatus,
  v1TaskImportRun,
  v1TaskImportStatus,
  v1IssueImportRun,
  v1IssueImportStatus,
} from "~/state/v1Import";

import {
  houston1ImportDescription,
  houston1ImportFailure,
  houston1ImportSteps,
  houston1ImportVisible,
  type Houston1ImportStatuses,
  type Houston1ImportStep,
} from "./houston1Import.logic";

export interface Houston1Import {
  readonly statuses: Houston1ImportStatuses;
  readonly steps: Houston1ImportStep[];
  readonly visible: boolean;
  readonly description: string;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly run: () => Promise<void>;
}

/** The Houston 1 import's statuses and the one sequence that copies them, in order. */
export function useHouston1Import(environmentId: EnvironmentId | null): Houston1Import {
  const tasks = useEnvironmentQuery(
    environmentId === null
      ? null
      : v1TaskImportStatus({ environmentId, input: V1_IMPORT_EMPTY_INPUT }),
  );
  const issues = useEnvironmentQuery(
    environmentId === null
      ? null
      : v1IssueImportStatus({ environmentId, input: V1_IMPORT_EMPTY_INPUT }),
  );
  const slack = useEnvironmentQuery(
    environmentId === null
      ? null
      : v1SlackImportStatus({ environmentId, input: V1_IMPORT_EMPTY_INPUT }),
  );
  const runTasks = useAtomCommand(v1TaskImportRun, { reportFailure: false });
  const runIssues = useAtomCommand(v1IssueImportRun, { reportFailure: false });
  const runSlack = useAtomCommand(v1SlackImportRun, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const statuses: Houston1ImportStatuses = {
    tasks: tasks.data,
    issues: issues.data,
    slack: slack.data,
  };
  const steps = houston1ImportSteps(statuses);

  const run = async () => {
    if (environmentId === null) return;
    setBusy(true);
    setFailure(null);
    // Each step runs only after the previous one succeeded; the first failure is shown.
    let failed: { readonly cause: unknown } | null = null;
    if (steps.includes("tasks")) {
      const result = await runTasks({ environmentId, input: V1_IMPORT_EMPTY_INPUT });
      if (result._tag === "Failure") failed = { cause: result.cause };
    }
    if (failed === null && steps.includes("issues")) {
      const result = await runIssues({ environmentId, input: V1_IMPORT_EMPTY_INPUT });
      if (result._tag === "Failure") failed = { cause: result.cause };
    }
    if (failed === null && steps.includes("slack")) {
      const result = await runSlack({ environmentId, input: V1_IMPORT_EMPTY_INPUT });
      if (result._tag === "Failure") failed = { cause: result.cause };
    }
    if (failed !== null) setFailure(houston1ImportFailure(failed.cause));
    tasks.refresh();
    issues.refresh();
    slack.refresh();
    setBusy(false);
  };

  return {
    statuses,
    steps,
    visible: houston1ImportVisible(statuses),
    description: houston1ImportDescription(statuses),
    busy,
    failure,
    run,
  };
}
