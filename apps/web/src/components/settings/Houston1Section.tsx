import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import {
  V1_IMPORT_EMPTY_INPUT,
  v1SlackImportRun,
  v1SlackImportStatus,
  v1TaskImportRun,
  v1TaskImportStatus,
  v1TaskSourceImportRun,
  v1TaskSourceImportStatus,
} from "~/state/v1Import";
import type { DesktopV1CleanupReport } from "@houston-app/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  houston1ImportDescription,
  houston1ImportFailure,
  houston1ImportSteps,
  houston1ImportVisible,
  type Houston1ImportStatuses,
} from "./houston1Import.logic";

export function Houston1ImportSection() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const tasks = useEnvironmentQuery(
    environmentId === null
      ? null
      : v1TaskImportStatus({ environmentId, input: V1_IMPORT_EMPTY_INPUT }),
  );
  const taskSources = useEnvironmentQuery(
    environmentId === null
      ? null
      : v1TaskSourceImportStatus({ environmentId, input: V1_IMPORT_EMPTY_INPUT }),
  );
  const slack = useEnvironmentQuery(
    environmentId === null
      ? null
      : v1SlackImportStatus({ environmentId, input: V1_IMPORT_EMPTY_INPUT }),
  );
  const runTasks = useAtomCommand(v1TaskImportRun, { reportFailure: false });
  const runTaskSources = useAtomCommand(v1TaskSourceImportRun, { reportFailure: false });
  const runSlack = useAtomCommand(v1SlackImportRun, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const statuses: Houston1ImportStatuses = {
    tasks: tasks.data,
    taskSources: taskSources.data,
    slack: slack.data,
  };
  const steps = houston1ImportSteps(statuses);
  const visible = houston1ImportVisible(statuses);
  if (!visible || environmentId === null) return null;

  const run = async () => {
    setBusy(true);
    setFailure(null);
    // Each step runs only after the previous one succeeded; the first failure is shown.
    let failed: { readonly cause: unknown } | null = null;
    if (steps.includes("tasks")) {
      const result = await runTasks({ environmentId, input: V1_IMPORT_EMPTY_INPUT });
      if (result._tag === "Failure") failed = { cause: result.cause };
    }
    if (failed === null && steps.includes("taskSources")) {
      const result = await runTaskSources({ environmentId, input: V1_IMPORT_EMPTY_INPUT });
      if (result._tag === "Failure") failed = { cause: result.cause };
    }
    if (failed === null && steps.includes("slack")) {
      const result = await runSlack({ environmentId, input: V1_IMPORT_EMPTY_INPUT });
      if (result._tag === "Failure") failed = { cause: result.cause };
    }
    if (failed !== null) setFailure(houston1ImportFailure(failed.cause));
    tasks.refresh();
    taskSources.refresh();
    slack.refresh();
    setBusy(false);
  };

  return (
    <SettingsSection id="houston-1" title="Coming from Houston 1">
      <SettingsRow
        id="houston-1-import"
        title="Import Houston 1 data"
        description={`Houston 1 conversations import automatically on first start. ${houston1ImportDescription(
          statuses,
        )}`}
        status={failure ?? undefined}
        control={
          steps.length > 0 ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
              {busy ? "Importing…" : "Import"}
            </Button>
          ) : null
        }
      />
    </SettingsSection>
  );
}

/** The host's one-time removal of v1's agent hooks, shown only when it has something to say. */
export function Houston1CleanupRow() {
  const [report, setReport] = useState<DesktopV1CleanupReport | null>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- reads the host's one-time cleanup report, which lives in the Electron main process and is not an atom
  useEffect(() => {
    const bridge = window.hostBridge?.houstonV1Cleanup;
    if (bridge === undefined) return;
    let cancelled = false;
    void bridge
      .getReport()
      .then((value) => {
        if (!cancelled) setReport(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (report === null) return null;
  if (!report.stoodDown && report.changed.length === 0) return null;
  const message = report.messages.at(-1);
  return (
    <SettingsSection id="houston-1-cleanup" title="Houston 1 cleanup">
      <SettingsRow
        id="houston-1-cleanup-row"
        title={report.stoodDown ? "Houston 1 is still running" : "Houston 1 agent hooks removed"}
        description={
          report.stoodDown
            ? (message ??
              "Quit Houston 1, then restart Houston to finish removing its agent hooks.")
            : `Removed Houston 1's agent hooks and MCP entries from ${report.changed.length} ${
                report.changed.length === 1 ? "file" : "files"
              }.`
        }
      />
    </SettingsSection>
  );
}
