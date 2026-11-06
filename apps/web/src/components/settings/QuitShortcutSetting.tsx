import { isDesktopHost } from "../../env";
import { DEFAULT_UNIFIED_SETTINGS } from "@houston-app/contracts/settings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const QUIT_SHORTCUT_LABELS = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Press twice",
} as const;

/** The quit shortcut only exists in the desktop host; a browser tab has no app to quit. */
export function QuitShortcutSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!isDesktopHost) return null;

  return (
    <SettingsRow
      {...searchableSetting("quit-shortcut")}
      description="Direct quits immediately. Hold or press twice makes the quit shortcut wait for a second press."
      resetAction={
        settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
          <SettingResetButton
            label="quit shortcut"
            onClick={() => updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.confirmQuit}
          onValueChange={(value) => {
            if (value === "direct" || value === "hold" || value === "double-click") {
              updateSettings({ confirmQuit: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Quit shortcut">
            <SelectValue>{QUIT_SHORTCUT_LABELS[settings.confirmQuit]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(QUIT_SHORTCUT_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
