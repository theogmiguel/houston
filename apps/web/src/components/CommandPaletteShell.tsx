import { useEffect, useRef, type ReactNode } from "react";

import {
  dispatchCommandPalette,
  getCommandPaletteReturnFocus,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import { preloadWhenIdle } from "../lib/preloadWhenIdle";
import { cn } from "../lib/utils";
import { restoreWorkspaceFocusFromPalette } from "../lib/workspaceFocus";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import {
  getCommandPaletteInputPlaceholder,
  type CommandPaletteOpenIntent,
  type CommandPaletteReturnContext,
} from "./CommandPalette.logic";
import { LazySurfaceBoundary, lazySurface } from "./LazySurface";
import { CommandDialog, CommandDialogPopup, CommandInputFallback } from "./ui/command-dialog";

const loadCommandPaletteBody = () => import("./CommandPalette");
const commandPaletteBody = lazySurface(() =>
  loadCommandPaletteBody().then((module) => module.CommandPaletteBody),
);
const passThrough = (content: ReactNode) => content;

// What the user typed into the fallback input while the palette's results loaded.
let earlyQuery: string | null = null;

function rememberEarlyQuery(text: string): void {
  earlyQuery = text;
}

/** The text typed before the palette loaded, which its search starts from. */
export function readEarlyCommandPaletteQuery(): string | null {
  return earlyQuery;
}

/** Called once the loaded input holds the early text, and whenever the palette closes. */
export function clearEarlyCommandPaletteQuery(): void {
  earlyQuery = null;
}

function setOpen(open: boolean): void {
  if (!open) clearEarlyCommandPaletteQuery();
  dispatchCommandPalette({ _tag: "SetOpen", open });
}

function openChildSearch(mode: "files" | "content", context: CommandPaletteReturnContext): void {
  dispatchCommandPalette({ _tag: "OpenChildSearch", mode, context });
}

function earlyInputPlaceholder(intent: CommandPaletteOpenIntent | null): string {
  return getCommandPaletteInputPlaceholder(
    intent === null || intent.kind === "search" ? "root" : "submenu",
  );
}

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- an idle callback that fetches the palette's chunk early; unmount cancels it.
  useEffect(() => preloadWhenIdle(loadCommandPaletteBody), []);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- an unmounted palette closes without calling setOpen, so its early text must not seed the next one.
  useEffect(() => clearEarlyCommandPaletteQuery, []);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            dispatchCommandPalette({ _tag: "BackToCommand" });
            return;
          }
          setOpen(open);
        }}
      >
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandDialogPopup
          aria-label={
            state.mode === "files"
              ? "File picker"
              : state.mode === "content"
                ? "Search project contents"
                : "Command palette"
          }
          className={cn("overflow-hidden", state.mode === "content" && "h-105")}
          data-command-palette="true"
          data-palette-mode={state.mode}
          data-testid="command-palette"
          finalFocus={() => {
            if (restoreWorkspaceFocusFromPalette()) return false;
            const returnFocus = getCommandPaletteReturnFocus();
            if (returnFocus === false) return false;
            const composer = composerHandleRef.current;
            // Behind the Settings modal the composer is inert and cannot take focus.
            if (!composer || document.querySelector("[data-app-modal]")) return returnFocus;
            composer.focusAtEnd();
            return false;
          }}
          onBackdropPointerDown={() => {
            setOpen(false);
          }}
        >
          <LazySurfaceBoundary
            surface={commandPaletteBody}
            props={{
              mode: state.mode,
              session: state.session,
              openIntent: state.openIntent,
              setOpen,
              openChildSearch,
              initialContext: state.restoredSearch,
            }}
            label="command palette"
            renderFrame={passThrough}
            loading={
              state.mode === "command" ? (
                <CommandInputFallback
                  defaultValue={state.openIntent?.kind === "search" ? state.openIntent.query : ""}
                  placeholder={earlyInputPlaceholder(state.openIntent)}
                  onChange={(event) => rememberEarlyQuery(event.currentTarget.value)}
                />
              ) : null
            }
          />
        </CommandDialogPopup>
      </CommandDialog>
    </ComposerHandleContext>
  );
}
