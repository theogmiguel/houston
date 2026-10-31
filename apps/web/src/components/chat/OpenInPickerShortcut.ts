import {
  buildRemoteOpenUrl,
  type EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { announce, cancelAnnouncement } from "../../lib/announce";
import { openRemoteEditorUrl, useRemoteCapableEditors, useRemoteOpenState } from "../../remoteOpen";
import { registerCommands } from "../../shortcuts/dispatcher";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

/** Marks an OpenInPicker's primary button as the target of `editor.openFavorite`. */
export const OPEN_FAVORITE_EDITOR_ATTRIBUTE = "data-open-favorite-editor";

/**
 * One announcement source for every open-in-editor attempt, so an attempt that fails
 * cancels a success that is still waiting to be spoken instead of the user hearing
 * "Opened in …" for an open that was refused. The command's failure path reports the error.
 */
const OPEN_IN_EDITOR_ANNOUNCEMENT = "open-in-editor";

export function announceOpenInEditor(label: string, opened: boolean) {
  if (opened) announce(`Opened in ${label}`, OPEN_IN_EDITOR_ANNOUNCEMENT);
  else cancelAnnouncement(OPEN_IN_EDITOR_ANNOUNCEMENT);
}

/**
 * `editor.openFavorite` presses the marked OpenInPicker primary button, so the shortcut opens
 * exactly what the button on screen would. A missing or disabled button leaves the chord to the
 * bubble-phase fallback below. Capture phase, so a focused terminal does not swallow the chord.
 */
export function registerOpenFavoriteEditorCommand(): () => void {
  return registerCommands(
    {
      "editor.openFavorite": (event) => {
        if (event.repeat) return false;
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>(`[${OPEN_FAVORITE_EDITOR_ATTRIBUTE}]`),
        ].at(-1);
        if (button === undefined || button.disabled) return false;
        event.preventDefault();
        button.click();
      },
    },
    { capture: true },
  );
}

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  // Matches the picker: remote editors run on the viewing machine.
  const [preferredEditor] = usePreferredEditor(
    remote.mode === "local-exec" ? availableEditors : remoteCapableEditors,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a window keydown listener for the open-in-editor shortcut while enabled
  useEffect(() => {
    if (!enabled || remote.mode === "remote-unavailable") return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        event.repeat ||
        event.defaultPrevented ||
        !isOpenFavoriteEditorShortcut(event, keybindings)
      )
        return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      const label = editorLabelForPlatform(preferredEditor, navigator.platform);
      if (remote.mode === "remote-links") {
        const url = buildRemoteOpenUrl({
          editor: preferredEditor,
          ...remote.host,
          absolutePath: openInCwd,
        });
        if (url === undefined) {
          announceOpenInEditor(label, false);
          return;
        }
        void openRemoteEditorUrl(url).then((opened) => {
          announceOpenInEditor(label, opened);
        });
        return;
      }
      void openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor: preferredEditor,
        },
      }).then((result) => {
        announceOpenInEditor(label, result._tag === "Success");
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    environmentId,
    keybindings,
    openInCwd,
    openInEditorMutation,
    preferredEditor,
    remote,
  ]);
}
