import type { ReactNode } from "react";

/**
 * The floating controls a single-thread grid pane reveals on hover. A card
 * label carries them when the grid shows two or more threads.
 */
export function GridPaneActions({ children }: { children: ReactNode }) {
  return (
    <div
      data-pane-actions=""
      className="absolute top-2 right-2 z-20 flex items-center gap-0.5 rounded-(--r-selection) border border-(--divider) bg-(--pane-head) px-0.5 opacity-0 transition-opacity duration-150 ease-out group-hover/pane:opacity-100 group-focus-within/pane:opacity-100 motion-reduce:transition-none"
    >
      {children}
    </div>
  );
}

/** The rename field a single-thread pane shows above its chat while editing. */
export function GridPaneRename({ children }: { children: ReactNode }) {
  return (
    <div
      data-pane-rename=""
      className="absolute top-2 left-2 z-20 flex h-(--h-pill) items-center rounded-(--r-selection) border border-(--divider) bg-(--pane-head) px-2"
    >
      {children}
    </div>
  );
}

export function GridPaneRenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      value={value}
      aria-label="Thread title"
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          onCancel();
          event.currentTarget.blur();
        }
      }}
      className="h-6 w-40 min-w-0 rounded-(--r-ctl) border border-input bg-background px-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    />
  );
}
