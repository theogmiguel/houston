import { useRef } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@houston-app/contracts/settings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { terminalEnvironment } from "../../state/terminal";
import { useT } from "../../i18n/useT";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_SHELL = "__default__";
const CUSTOM_SHELL = "__custom__";

export function TerminalShellSetting() {
  const t = useT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const edited = useRef(false);
  const environmentId = usePrimaryEnvironmentId();
  const shells = useEnvironmentQuery(
    environmentId === null ? null : terminalEnvironment.shells({ environmentId, input: {} }),
  );

  const candidates = shells.data?.candidates ?? [];
  const defaultShell = shells.data?.defaultShell ?? "";
  const configured = settings.terminalShell;
  const detected = candidates.some((candidate) => candidate.shell === configured);
  const selectValue =
    configured.length === 0 ? DEFAULT_SHELL : detected ? configured : CUSTOM_SHELL;
  const defaultLabel =
    defaultShell.length > 0
      ? t("System default ({shell})", { shell: defaultShell })
      : t("System default");
  const effective = configured.length === 0 ? defaultLabel : configured;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["terminalShell"]}
      {...searchableSetting("terminal-shell")}
      title={t("Shell")}
      description={t(
        "The interactive shell new terminals start. Terminals that are already open keep their shell.",
      )}
      status={[
        t("Current: {shell}", { shell: effective }),
        configured.length > 0 && !detected && shells.data !== null
          ? t(
              "This shell is not in the detected list. New terminals fall back to the default when it is unavailable.",
            )
          : null,
        shells.error !== null ? t("Could not detect installed shells.") : null,
      ]
        .filter((message): message is string => message !== null)
        .join(" ")}
      resetAction={
        configured !== DEFAULT_UNIFIED_SETTINGS.terminalShell ? (
          <SettingResetButton
            label={t("shell")}
            onClick={() => updateSettings({ terminalShell: "" })}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-col gap-2 sm:w-80">
          <Select
            value={selectValue}
            onValueChange={(value) => {
              if (value === null || value === CUSTOM_SHELL) return;
              updateSettings({ terminalShell: value === DEFAULT_SHELL ? "" : value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("Shell")}>
              <SelectValue>
                {configured.length === 0 ? defaultLabel : detected ? configured : t("Custom path")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={DEFAULT_SHELL}>{defaultLabel}</SelectItem>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.shell} value={candidate.shell}>
                  {candidate.label} · {candidate.shell}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_SHELL}>{t("Custom path")}</SelectItem>
            </SelectPopup>
          </Select>
          <Input
            key={`${configured}:${selectValue}`}
            aria-label={t("Custom shell path")}
            font="mono"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t("Path to an executable shell")}
            defaultValue={selectValue === CUSTOM_SHELL ? configured : ""}
            onChange={() => {
              edited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (edited.current && value !== configured) updateSettings({ terminalShell: value });
              edited.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>
      }
    />
  );
}
