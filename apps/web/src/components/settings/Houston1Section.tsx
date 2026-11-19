import type { DesktopV1CleanupReport } from "@houston-app/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useHouston1Import } from "./useHouston1Import";

export function Houston1ImportSection() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { steps, visible, description, busy, failure, run } = useHouston1Import(environmentId);
  if (!visible || environmentId === null) return null;

  return (
    <SettingsSection id="houston-1" title="Coming from Houston 1">
      <SettingsRow
        id="houston-1-import"
        title="Import Houston 1 data"
        description={description}
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
