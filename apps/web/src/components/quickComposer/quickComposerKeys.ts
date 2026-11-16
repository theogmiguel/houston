import type { ClientSettings } from "@houston-app/contracts/settings";

import { composerRequiresModifier } from "../../composer-logic";

type SendShortcut = ClientSettings["sendShortcut"];

export function quickComposerEnterSubmits(
  event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  sendShortcut: SendShortcut,
  prompt: string,
): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  return !composerRequiresModifier(sendShortcut, prompt) || event.metaKey || event.ctrlKey;
}

export function quickComposerHint(sendShortcut: SendShortcut): string {
  switch (sendShortcut) {
    case "mod-enter":
      return "Ctrl/Cmd+Enter starts the thread. Enter adds a line.";
    case "mod-enter-multiline":
      return "Enter starts the thread; once the prompt has several lines, Ctrl/Cmd+Enter does.";
    default:
      return "Enter starts the thread. Shift+Enter adds a line.";
  }
}
