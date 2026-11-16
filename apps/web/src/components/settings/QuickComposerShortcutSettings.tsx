import type {
  DesktopQuickComposerShortcutStatus,
  KeybindingShortcut,
} from "@houston-app/contracts";
import { parseKeybindingShortcut } from "@houston-app/shared/keybindings";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { formatShortcutLabel } from "../../keybindings";
import { isDesktopHost } from "../../env";
import { Button } from "../ui/button";
import { Kbd, KbdGroup } from "../ui/kbd";
import { Switch } from "../ui/switch";
import { keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function keyParts(shortcut: KeybindingShortcut): string[] {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key);
  return parts;
}

function ShortcutKeys({ shortcut }: { shortcut: KeybindingShortcut }) {
  return (
    <KbdGroup>
      {keyParts(shortcut).map((part) => (
        <Kbd key={part}>
          {part === "mod"
            ? navigator.platform.toLowerCase().includes("mac")
              ? "⌘"
              : "Ctrl"
            : part === "ctrl"
              ? "⌃"
              : part === "shift"
                ? "⇧"
                : part === "alt"
                  ? navigator.platform.toLowerCase().includes("mac")
                    ? "⌥"
                    : "Alt"
                  : part === "meta"
                    ? "Super"
                    : part === "space"
                      ? "Space"
                      : part.length === 1
                        ? part.toUpperCase()
                        : part}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

export function QuickComposerShortcutSettings() {
  const bridge = typeof window === "undefined" ? undefined : window.hostBridge;
  const [status, setStatus] = useState<DesktopQuickComposerShortcutStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- reads the native host's registered shortcut status once
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge
      .getQuickComposerStatus()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (alive) {
          setError(cause instanceof Error ? cause.message : "Could not read the shortcut.");
        }
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

  if (!isDesktopHost || !bridge) return null;

  const save = async (shortcut: KeybindingShortcut | null) => {
    setError(null);
    try {
      setStatus(await bridge.setQuickComposerShortcut(shortcut));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the shortcut.");
    }
  };

  const record = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording || event.repeat) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      setError("Add Ctrl, Alt, Shift or Super so the shortcut does not take a plain key.");
      return;
    }
    const input = keybindingFromKeyboardEvent(event.nativeEvent, navigator.platform, {
      layoutCharacter: true,
    });
    const shortcut = input === null ? null : parseKeybindingShortcut(input);
    if (shortcut === null) {
      setError("That key cannot be used as a global shortcut. Try a letter or Space.");
      return;
    }
    setRecording(false);
    void save(shortcut);
  };

  const shortcut = status?.shortcut ?? null;
  const registrationStatus =
    error ??
    (status === null
      ? "Reading the current shortcut…"
      : status.reason !== null
        ? status.reason
        : !status.enabled
          ? "Turned off. The shortcut does not open the quick composer."
          : status.registered
            ? "Opens the quick composer from any app."
            : "Not registered.");

  return (
    <SettingsSection id="quick-composer" title="Quick composer">
      <SettingsRow
        title="Global shortcut"
        description="Open a small composer to start a thread in any project without bringing Houston forward."
        status={registrationStatus}
        control={
          <div className="flex items-center gap-2">
            {shortcut !== null ? <ShortcutKeys shortcut={shortcut} /> : null}
            <Button
              ref={buttonRef}
              type="button"
              size="xs"
              variant={recording ? "secondary" : "outline"}
              aria-pressed={recording}
              aria-label={
                shortcut === null
                  ? "Set quick composer shortcut"
                  : `Change quick composer shortcut, currently ${formatShortcutLabel(shortcut)}`
              }
              data-keybinding-capture=""
              onClick={() => {
                setError(null);
                setRecording(true);
                buttonRef.current?.focus();
              }}
              onKeyDown={record}
              onBlur={() => setRecording(false)}
            >
              {recording ? "Press shortcut…" : "Change"}
            </Button>
            <Switch
              checked={status?.enabled ?? false}
              aria-label="Enable quick composer shortcut"
              onCheckedChange={(checked) => {
                if (checked) void save(shortcut);
                else void save(null);
              }}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
