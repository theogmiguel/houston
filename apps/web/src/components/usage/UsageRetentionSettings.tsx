import {
  effectiveUsageRetentionDays,
  USAGE_RETENTION_DEFAULT_DAYS,
  USAGE_RETENTION_MAX_DAYS,
  USAGE_RETENTION_MIN_DAYS,
  type UsageRetentionDays,
} from "@houston-app/contracts";
import { useState } from "react";

import { useT } from "../../i18n/useT";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Text } from "../ui/text";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import { searchableSetting } from "../settings/settingsSearch";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";
import { usageRetentionShortens } from "./usageRetention";

function clampRetentionDays(days: number): number {
  return Math.min(USAGE_RETENTION_MAX_DAYS, Math.max(USAGE_RETENTION_MIN_DAYS, Math.round(days)));
}

export function UsageRetentionSettings() {
  const t = useT();
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["usageRetentionDays"]);
  const [pending, setPending] = useState<UsageRetentionDays | undefined>(undefined);
  // A server from before this setting sends no key; its fixed window was the default.
  const storedValue = settings.usageRetentionDays as UsageRetentionDays | undefined;
  const value: UsageRetentionDays =
    storedValue === undefined ? USAGE_RETENTION_DEFAULT_DAYS : storedValue;
  const [draft, setDraft] = useState<number | null>(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.usageHistoryRetention === true,
    );
  if (!supported) return null;

  const selectedValues = targets.map((target) => target.settings.usageRetentionDays);
  const apply = (next: UsageRetentionDays) => {
    if (usageRetentionShortens(selectedValues, next)) setPending(next);
    else updateSettings({ usageRetentionDays: next });
  };
  const status = mixed
    ? t("Mixed across selected machines")
    : value === null
      ? t("Keeping all available history, up to {days} days.", {
          days: USAGE_RETENTION_MAX_DAYS,
        })
      : t("Keeping {days} days.", { days: value });
  const pendingDays = pending === undefined ? null : effectiveUsageRetentionDays(pending);
  const draftDays = draft ?? USAGE_RETENTION_DEFAULT_DAYS;

  return (
    <>
      <SettingsSection id="usage-history" title={t("Usage history")}>
        <SettingsRow
          {...searchableSetting("usage-history-retention")}
          title={t("Usage history retention")}
          status={status}
          description={t(
            "How long Houston keeps saved usage for transcripts the providers no longer keep. Shortening it deletes older records on the next Usage refresh, and that cannot be undone. Longer settings never restore records that were already deleted.",
          )}
          serverScoped
          settingKeys={["usageRetentionDays"]}
          resetAction={
            mixed || value !== USAGE_RETENTION_DEFAULT_DAYS ? (
              <SettingResetButton
                label={t("usage history retention")}
                onClick={() => apply(USAGE_RETENTION_DEFAULT_DAYS)}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-3">
              {draft === null ? (
                <Text variant="caption" tone="muted">
                  {t("All available history")}
                </Text>
              ) : (
                <NumberField
                  value={draftDays}
                  min={USAGE_RETENTION_MIN_DAYS}
                  max={USAGE_RETENTION_MAX_DAYS}
                  step={1}
                  size="sm"
                  className="w-auto"
                  onValueChange={(next) => {
                    if (next !== null) setDraft(next);
                  }}
                  onValueCommitted={(next) => {
                    if (next === null) setDraft(draft);
                    else apply(clampRetentionDays(next));
                  }}
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label={t("Decrease usage history retention")} />
                    <NumberFieldInput
                      aria-label={t("Usage history retention in days")}
                      size={5}
                      className="w-auto grow-0"
                    />
                    <Text
                      as="span"
                      variant="caption"
                      tone="muted"
                      aria-hidden="true"
                      className="self-center pr-2"
                    >
                      {t("days")}
                    </Text>
                    <NumberFieldIncrement aria-label={t("Increase usage history retention")} />
                  </NumberFieldGroup>
                </NumberField>
              )}
              <Switch
                aria-label={t("Keep all available history")}
                checked={draft === null}
                onCheckedChange={(checked) => apply(checked ? null : USAGE_RETENTION_DEFAULT_DAYS)}
              />
            </div>
          }
        />
      </SettingsSection>
      <AlertDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete older usage records?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Keeping {days} days deletes every saved Usage record older than that on the next Usage refresh. This cannot be undone. Provider transcripts are not deleted.",
                { days: pendingDays ?? USAGE_RETENTION_DEFAULT_DAYS },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const next = pending;
                setPending(undefined);
                if (next !== undefined) updateSettings({ usageRetentionDays: next });
              }}
            >
              {t("Delete older records")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
