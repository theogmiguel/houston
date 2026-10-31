import { useRef } from "react";
import { BranchNamingMode, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MODES = {
  static: "Static prefix",
  semantic: "Semantic prefix",
  custom: "Custom instructions",
} satisfies Record<BranchNamingMode, string>;

function parseBranchTemplate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith("/{slug}")) return trimmed.slice(0, -"/{slug}".length);
  if (trimmed.endsWith("{slug}")) return trimmed.slice(0, -"{slug}".length).replace(/\/$/u, "");
  return trimmed.replace(/\{slug\}/gu, "").replace(/\/$/u, "");
}

function formatBranchTemplate(prefix: string): string {
  return prefix === "" ? "{slug}" : `${prefix}/{slug}`;
}

/** The board's single Worktree branch naming field, backed by the branch prefix setting. */
export function WorktreeBranchNamingRow() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const prefixMixed = useScopedSettingsMixed(["branchNamePrefix"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["branchNamePrefix"]}
      {...searchableSetting("worktree-branch-naming")}
      title="Worktree branch naming"
      description="How a new worktree's branch is named."
      resetAction={
        prefixMixed || settings.branchNamePrefix !== DEFAULT_SERVER_SETTINGS.branchNamePrefix ? (
          <SettingResetButton
            label="worktree branch naming"
            onClick={() =>
              updateSettings({ branchNamePrefix: DEFAULT_SERVER_SETTINGS.branchNamePrefix })
            }
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${prefixMixed}:${settings.branchNamePrefix}`}
          className="w-full sm:w-[190px]"
          font="mono"
          aria-label="Worktree branch naming"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={prefixMixed ? "Mixed" : "houston/{slug}"}
          defaultValue={prefixMixed ? "" : formatBranchTemplate(settings.branchNamePrefix)}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = parseBranchTemplate(event.target.value);
            if (edited.current && (prefixMixed || value !== settings.branchNamePrefix))
              updateSettings({ branchNamePrefix: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

/** Upstream's mode, prefix and instructions rows, kept after the board's single field. */
export function BranchNamingAdvancedSettings() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const prefixEdited = useRef(false);
  const instructionsEdited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const modeMixed = useScopedSettingsMixed(["branchNamingMode"]);
  const prefixMixed = useScopedSettingsMixed(["branchNamePrefix"]);
  const instructionsMixed = useScopedSettingsMixed(["branchNameInstructions"]);

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["branchNamingMode"]}
        title="Branch naming mode"
        description="Choose how new worktree branches are named from your first message."
        status={
          !modeMixed && settings.branchNamingMode === "semantic"
            ? "The model chooses a prefix that describes the work, such as feat/add-search, fix/login-timeout, or refactor/auth."
            : undefined
        }
        resetAction={
          settings.branchNamingMode !== DEFAULT_SERVER_SETTINGS.branchNamingMode || modeMixed ? (
            <SettingResetButton
              label="branch naming"
              onClick={() =>
                updateSettings({ branchNamingMode: DEFAULT_SERVER_SETTINGS.branchNamingMode })
              }
            />
          ) : null
        }
        control={
          <Select
            value={modeMixed ? null : settings.branchNamingMode}
            onValueChange={(value) => {
              if (BranchNamingMode.literals.includes(value as BranchNamingMode)) {
                updateSettings({ branchNamingMode: value as BranchNamingMode });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Branch naming mode">
              <SelectValue>
                {(value: BranchNamingMode | null) => (value === null ? "Mixed" : MODES[value])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BranchNamingMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {MODES[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {!modeMixed && settings.branchNamingMode === "static" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNamePrefix"]}
          title="Branch prefix"
          description="For example, houston or houston/ produces houston/add-search. Leave empty for no prefix."
          resetAction={
            prefixMixed ||
            settings.branchNamePrefix !== DEFAULT_SERVER_SETTINGS.branchNamePrefix ? (
              <SettingResetButton
                label="branch prefix"
                onClick={() =>
                  updateSettings({ branchNamePrefix: DEFAULT_SERVER_SETTINGS.branchNamePrefix })
                }
              />
            ) : null
          }
          control={
            <Input
              key={`${scopeKey}:${prefixMixed}:${settings.branchNamePrefix}`}
              aria-label="Branch prefix"
              autoCapitalize="none"
              spellCheck={false}
              onChange={() => {
                prefixEdited.current = true;
              }}
              placeholder={prefixMixed ? "Mixed" : "No prefix"}
              defaultValue={prefixMixed ? "" : settings.branchNamePrefix}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (prefixEdited.current && (prefixMixed || value !== settings.branchNamePrefix))
                  updateSettings({ branchNamePrefix: value });
                prefixEdited.current = false;
              }}
            />
          }
        />
      ) : null}
      {!modeMixed && settings.branchNamingMode === "custom" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNameInstructions"]}
          title="Branch naming instructions"
          description="Appended to the naming prompt. The model returns the complete branch name; no prefix or suffix is added."
          resetAction={
            instructionsMixed || settings.branchNameInstructions !== "" ? (
              <SettingResetButton
                label="branch naming instructions"
                onClick={() => updateSettings({ branchNameInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={`${scopeKey}:${instructionsMixed}:${settings.branchNameInstructions}`}
              aria-label="Branch naming instructions"
              onChange={() => {
                instructionsEdited.current = true;
              }}
              rows={4}
              defaultValue={instructionsMixed ? "" : settings.branchNameInstructions}
              placeholder={
                instructionsMixed
                  ? "Mixed. Enter instructions to apply to all selected targets."
                  : "Use julius/ followed by the issue ID and a short description."
              }
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (
                  instructionsEdited.current &&
                  (instructionsMixed || value !== settings.branchNameInstructions)
                )
                  updateSettings({ branchNameInstructions: value });
                instructionsEdited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}
