/**
 * The one-shot hints the layout shows after a keyboard move or a workspace switch: "Column 2 of 4",
 * "Research · workspace 2 of 3", "Terminal for <thread>". The store holds the hint; this draws it
 * at the bottom center of its nearest positioned ancestor, which the strip host provides, and
 * fades it once.
 */
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@houston-app/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { Kbd } from "../components/ui/kbd";
import { LayoutHintLabel, LayoutHintMark, LayoutHintShell } from "../components/ui/layout-overlay";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { countedLayoutWorkspaces } from "./layoutCommands";
import { selectFocusedWorkspace, type LayoutWorkspace } from "./layoutModel";
import { useLayoutStore, type LayoutHint as LayoutHintState } from "./layoutStore";
import { workspaceDisplayName } from "./layoutWorkspaces";

/** How many workspace bars the stack glyph draws before it scrolls. */
const WORKSPACE_BARS = 5;
/** Column cells the strip glyph draws before it stops adding cells. */
const COLUMN_CELLS = 8;

/** A trailing arrow key name in a shortcut label. */
const TRAILING_ARROW = /(Left|Right|Up|Down)$/;

const ARROWS: Record<string, string> = { Left: "←", Right: "→", Up: "↑", Down: "↓" };

/** How long a hint stays before its one-shot fade; long enough to read a short label once. */
export const HINT_VISIBLE_MS = 2400;
/** The fade's length, matched to the overlay-out role. */
export const HINT_FADE_MS = 200;

/** Fades the hint after a beat, then clears it; true once the fade has started. */
function useHintLifetime(id: number | null): boolean {
  const [leavingId, setLeavingId] = useState<number | null>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Own and cancel the visible hint dismissal timers.
  useEffect(() => {
    if (id === null) return;
    const fade = window.setTimeout(() => setLeavingId(id), HINT_VISIBLE_MS);
    const clear = window.setTimeout(
      () => useLayoutStore.getState().clearHint(id),
      HINT_VISIBLE_MS + HINT_FADE_MS,
    );
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(clear);
    };
  }, [id]);
  return id !== null && leavingId === id;
}

export interface LayoutHintsProps {
  /** The title of an unnamed workspace, such as its lead tab's title. */
  readonly resolveWorkspaceTitle?: (workspace: LayoutWorkspace) => string | null;
  /** The thread's title for the terminal hint. */
  readonly resolveThreadTitle?: (ref: ScopedThreadRef) => string | null;
}

/** Names the workspace a switch landed on, unless a move hint already says so. */
function useWorkspaceSwitchHint(): void {
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Subscribe to imperative workspace changes that should display a navigation hint.
  useEffect(() => {
    let overviewOpenedOn: string | null = null;
    return useLayoutStore.subscribe((state, previous) => {
      if (state.overviewOpen) {
        if (previous.overviewOpen) return;
        overviewOpenedOn = previous.layout.focusedWorkspaceId;
        if (state.hint) state.clearHint(state.hint.id);
        return;
      }
      const left = previous.overviewOpen ? overviewOpenedOn : previous.layout.focusedWorkspaceId;
      if (state.layout.focusedWorkspaceId === left) return;
      if (state.hint?.kind === "workspace" && state.hint.id !== previous.hint?.id) return;
      const workspaces = countedLayoutWorkspaces(state.layout);
      const workspace = selectFocusedWorkspace(state.layout);
      // One workspace has nothing to tell apart.
      if (workspaces.length < 2) {
        if (state.hint?.kind === "workspace-name") state.clearHint(state.hint.id);
        return;
      }
      state.showHint({
        kind: "workspace-name",
        workspaceId: workspace.id,
        index: workspaces.indexOf(workspace),
        count: workspaces.length,
      });
    });
  }, []);
}

export function LayoutHints({ resolveWorkspaceTitle, resolveThreadTitle }: LayoutHintsProps) {
  const hint = useLayoutStore((state) => state.hint);
  useWorkspaceSwitchHint();
  if (!hint) return null;
  if (hint.kind === "terminal") {
    return <TerminalHintPill key={hint.id} hint={hint} resolveThreadTitle={resolveThreadTitle} />;
  }
  if (hint.kind === "column") return <ColumnHintPill key={hint.id} hint={hint} />;
  return <WorkspaceHintPill key={hint.id} hint={hint} resolveTitle={resolveWorkspaceTitle} />;
}

function HintPill({
  kind,
  leaving,
  small = false,
  children,
}: {
  kind: LayoutHintState["kind"];
  leaving: boolean;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <LayoutHintShell data-layout-hint={kind} leaving={leaving} small={small}>
      {children}
    </LayoutHintShell>
  );
}

function Shortcut({ label }: { label: string | null }) {
  return label ? (
    <span className="flex shrink-0">
      <Kbd>{label}</Kbd>
    </span>
  ) : null;
}

function TerminalHintPill({
  hint,
  resolveThreadTitle,
}: {
  hint: Extract<LayoutHintState, { kind: "terminal" }>;
  resolveThreadTitle: LayoutHintsProps["resolveThreadTitle"];
}) {
  const leaving = useHintLifetime(hint.id);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return (
    <HintPill kind="terminal" leaving={leaving}>
      <LayoutHintLabel>
        Terminal for {resolveThreadTitle?.(hint.threadRef) ?? "New thread"}
      </LayoutHintLabel>
      <Shortcut label={shortcutLabelForCommand(keybindings, "terminal.toggle")} />
    </HintPill>
  );
}

/** "Research · workspace 2 of 3" after sending a pane, or just the name after switching. */
function WorkspaceHintPill({
  hint,
  resolveTitle,
}: {
  hint: Extract<LayoutHintState, { kind: "workspace" | "workspace-name" }>;
  resolveTitle: LayoutHintsProps["resolveWorkspaceTitle"];
}) {
  const leaving = useHintLifetime(hint.id);
  const layout = useLayoutStore((state) => state.layout);
  const workspace = layout.workspaces.find((candidate) => candidate.id === hint.workspaceId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keys =
    hint.kind === "workspace" && hint.command
      ? shortcutLabelForCommand(keybindings, hint.command)
      : null;
  const small = hint.kind === "workspace-name";
  const firstBar = Math.max(0, Math.min(hint.index - 2, hint.count - WORKSPACE_BARS));
  const name = workspace
    ? workspaceDisplayName(workspace, layout.workspaces.indexOf(workspace), resolveTitle)
    : "Workspace";
  return (
    <HintPill kind={hint.kind} leaving={leaving} small={small}>
      <span aria-hidden className="flex shrink-0 flex-col items-center gap-px">
        {Array.from({ length: Math.min(hint.count, WORKSPACE_BARS) }, (_, bar) => {
          const index = firstBar + bar;
          const more =
            (bar === 0 && index > 0) || (bar === WORKSPACE_BARS - 1 && index < hint.count - 1);
          return (
            <LayoutHintMark
              key={bar}
              shape="bar"
              active={index === hint.index}
              narrow={more}
              small={small}
            />
          );
        })}
      </span>
      <LayoutHintLabel>
        {hint.kind === "workspace"
          ? `${name} · workspace ${hint.index + 1} of ${hint.count}`
          : name}
      </LayoutHintLabel>
      <Shortcut label={keys} />
    </HintPill>
  );
}

/** "Column 2 of 4" with a strip of cells, after a keyboard move or pull. */
function ColumnHintPill({ hint }: { hint: Extract<LayoutHintState, { kind: "column" }> }) {
  const leaving = useHintLifetime(hint.id);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const label = hint.command ? shortcutLabelForCommand(keybindings, hint.command) : null;
  const keys = label?.replace(TRAILING_ARROW, (name) => ARROWS[name] ?? name) ?? null;
  return (
    <HintPill kind="column" leaving={leaving}>
      <span aria-hidden className="flex shrink-0 items-center gap-0.5">
        {Array.from({ length: Math.min(hint.count, COLUMN_CELLS) }, (_, index) => (
          <LayoutHintMark
            key={index}
            shape="cell"
            active={index === Math.min(hint.index, COLUMN_CELLS - 1)}
          />
        ))}
      </span>
      <LayoutHintLabel>
        Column {hint.index + 1} of {hint.count}
      </LayoutHintLabel>
      <Shortcut label={keys} />
    </HintPill>
  );
}
