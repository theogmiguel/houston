import { pasteTextToFocusComposer, shouldRedirectInputToComposer } from "./composerFocusRedirect";
import { readPastedComposerContext } from "../composerInlineTokenPaste";
import { DESKTOP_PASTE_AS_TEXT_EVENT } from "../../lib/desktopPasteAsText";
import { isClipboardImagePaste, readHostClipboardImageFile } from "./hostClipboardImage";
import { splitTransferredFiles } from "./workspaceFileDrop";
import { isPasteAsTextShortcut } from "@houston-app/client-runtime/text-paste";
import { transferredPaths } from "../../lib/fileTransfer";
import { useEffect, useRef } from "react";
import { isMacPlatform } from "../../lib/utils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { isInSideChatPane } from "../../lib/sideChatPane";
import { toastManager } from "../ui/toast";
import type { ThreadId } from "@houston-app/contracts";
import type { ComposerHandleRef } from "../../composerHandleContext";
/**
 * Paste-to-focus: the resting composer blurs on a click into the timeline, so a paste that
 * follows has no editable target and would be dropped. This sends it to the composer instead.
 */
export function usePasteToFocusComposer(
  activeThreadId: ThreadId | null,
  composerRef: ComposerHandleRef,
) {
  const pasteAsTextShortcutUntilRef = useRef(0);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- attaches window keydown and paste capture listeners that route stray pastes into the composer
  useEffect(() => {
    if (!activeThreadId) return;
    const keyHandler = (event: KeyboardEvent) => {
      if (
        shouldRedirectInputToComposer(event) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
      }
    };
    const handler = (event: ClipboardEvent) => {
      if (isCommandPaletteOpen() || isInSideChatPane(event.target)) return;
      if (getTerminalFocusOwner() !== null) return;
      if (composerRef.current?.isModelPickerOpen()) return;
      const clipboardData = event.clipboardData;
      if (clipboardData === null) return;
      if (!shouldRedirectInputToComposer(event)) return;

      const { files, folders } = splitTransferredFiles(clipboardData);
      const paths = transferredPaths(clipboardData);
      const pathsOnly = files.length === 0 && folders.length === 0 && paths.length > 0;
      if (folders.length > 0 || files.length > 0 || pathsOnly) {
        event.preventDefault();
        event.stopPropagation();
        if (folders.length > 0) composerRef.current?.addDroppedFolders(folders, paths);
        if (pathsOnly) composerRef.current?.confirmPastedPaths(paths);
        if (files.length > 0) composerRef.current?.addDroppedFiles(files);
        return;
      }

      const readHostClipboardImage = window.hostBridge?.readClipboardImage;
      if (readHostClipboardImage && isClipboardImagePaste(clipboardData)) {
        event.preventDefault();
        event.stopPropagation();
        void readHostClipboardImageFile(readHostClipboardImage)
          .then((image) => {
            if (image !== null) composerRef.current?.addDroppedFiles([image]);
          })
          .catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Couldn't paste the clipboard image",
              description: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }

      const text = pasteTextToFocusComposer(event);
      if (text === null) return;
      const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntilRef.current;
      pasteAsTextShortcutUntilRef.current = 0;
      if (
        ((readPastedComposerContext(clipboardData)?.records.length ?? 0) === 0 &&
          composerRef.current?.pasteTextAtEnd(text, { bypassAutoAttachment })) ||
        composerRef.current?.insertTextAtEnd(text, { clipboardData })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onDesktopPasteAsText = () => {
      pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
    };
    window.addEventListener("keydown", keyHandler, true);
    window.addEventListener("paste", handler, true);
    window.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
    return () => {
      window.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("paste", handler, true);
      window.removeEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
    };
  }, [activeThreadId, composerRef]);
}
