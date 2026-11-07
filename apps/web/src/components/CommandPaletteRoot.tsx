import { lazy, Suspense, useRef, useState, type ReactNode } from "react";

import {
  dispatchCommandPalette,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import type { CommandPaletteReturnContext } from "./CommandPalette.logic";
import { CommandDialog } from "./ui/command";

// The dialog's code loads when the palette first opens; the shell keeps the store, the
// shortcuts and the composer handle mounted from boot.
const CommandPaletteDialog = lazy(() =>
  import("./CommandPalette").then((module) => ({ default: module.CommandPaletteDialog })),
);

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  // Stays mounted after the first open so the popup can play its exit.
  const [opened, setOpened] = useState(state.open);
  if (state.open && !opened) setOpened(true);
  const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });
  const openChildSearch = (mode: "files" | "content", context: CommandPaletteReturnContext) =>
    dispatchCommandPalette({ _tag: "OpenChildSearch", mode, context });
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

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
        {opened ? (
          <Suspense fallback={null}>
            <CommandPaletteDialog
              mode={state.mode}
              session={state.session}
              openIntent={state.openIntent}
              setOpen={setOpen}
              openChildSearch={openChildSearch}
              initialContext={state.restoredSearch}
            />
          </Suspense>
        ) : null}
      </CommandDialog>
    </ComposerHandleContext>
  );
}
