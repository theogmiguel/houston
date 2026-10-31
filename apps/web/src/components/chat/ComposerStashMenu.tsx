import { FileIcon, FileTextIcon, ImageIcon, XIcon } from "lucide-react";
import { memo, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

import { formatShortcutLabel } from "~/keybindings";
import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { ScrollArea } from "../ui/scroll-area";
import { type PromptStashEntry } from "../../promptStashStore";

const SNIPPET_MAX_CHARS = 90;

function missingImageCount(entry: PromptStashEntry): number {
  return entry.droppedImageNames.length + (entry.unreadableImageNames?.length ?? 0);
}

function stashEntrySnippet(entry: PromptStashEntry): string {
  const trimmed = assistantCitationsToPlainText(entry.prompt).trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
  }
  const imageCount = entry.attachments.length + entry.droppedImageNames.length;
  const fileCount = entry.files?.length ?? 0;
  const attachmentCount = imageCount + fileCount;
  if (attachmentCount === 0) {
    return "(empty)";
  }
  const label = imageCount > 0 && fileCount > 0 ? "attachment" : fileCount > 0 ? "file" : "image";
  return `(${attachmentCount} ${label}${attachmentCount === 1 ? "" : "s"})`;
}

/** Window capture gives the open menu priority over composer key handlers. */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  stashShortcutLabel: string | null;
  composerFormRef: RefObject<HTMLFormElement | null>;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
  onClose: () => void;
}) {
  const { entries, stashShortcutLabel, composerFormRef, onRestore, onDelete, onClose } = props;
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);

  const highlightedEntry = entries.find((entry) => entry.id === highlightedId) ?? entries[0];
  const drawerRef = useRef<HTMLDivElement>(null);
  // The menu deletes with the modifier plus Backspace; the hint names the current platform's key.
  const deleteShortcutLabel = formatShortcutLabel({
    key: "Backspace",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
  });

  // Both listeners read entries, highlight and callbacks at event time, so they subscribe
  // once for the menu's lifetime instead of on every highlight change.
  const closeOnOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const drawer = drawerRef.current;
    if (
      (drawer && event.composedPath().includes(drawer)) ||
      (event.target instanceof Element && event.target.closest('[data-prompt-stash-badge="true"]'))
    ) {
      return;
    }
    onClose();
  });

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const drawer = drawerRef.current;
    if (!drawer) return;
    const target = event.target;
    if (
      !(target instanceof Node) ||
      (target !== document.body &&
        !(target instanceof Element && target.closest('[data-prompt-stash-badge="true"]')) &&
        !drawer.contains(target) &&
        !composerFormRef.current?.querySelector('textarea, [role="textbox"]')?.contains(target))
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (entries.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const currentIndex = entries.findIndex((entry) => entry.id === highlightedEntry?.id);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
      const nextIndex = (normalizedIndex + offset + entries.length) % entries.length;
      setHighlightedId(entries[nextIndex]?.id ?? null);
      const nextButton =
        drawer.querySelectorAll<HTMLButtonElement>("[data-stash-restore]")[nextIndex];
      nextButton?.scrollIntoView({ block: "nearest" });
      if (drawer.contains(document.activeElement)) {
        nextButton?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === "Enter") {
      // Let the delete button handle Enter instead of restoring its row.
      if (event.target instanceof HTMLElement && event.target.closest("button[aria-label]")) {
        return;
      }
      if (!highlightedEntry) return;
      event.preventDefault();
      event.stopPropagation();
      onRestore(highlightedEntry);
      return;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
      if (!highlightedEntry) return;
      event.preventDefault();
      event.stopPropagation();
      onDelete(highlightedEntry);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes capture-phase pointerdown and keydown listeners for outside close and keyboard navigation
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => closeOnOutsidePointer(event);
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return (
    <div
      ref={drawerRef}
      data-composer-stash-drawer="true"
      className="dialog-glass mb-2 grid gap-px rounded-(--r-group) p-1 text-headline text-popover-foreground"
    >
      <div className="flex h-7.5 items-center ps-2 pe-1 text-xs font-semibold text-muted-foreground">
        <span>Stashed prompts</span>
        <span className="flex-1" />
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="Close stash"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <ScrollArea radius="none" scrollFade className="h-auto max-h-[min(24rem,40dvh)]">
        <ul role="list" aria-label="Stashed prompts" className="grid gap-px">
          {entries.length === 0 ? (
            <li className="flex min-h-8.5 items-center rounded-(--r-ctl) px-2 py-1.5 text-xs text-muted-foreground">
              Nothing stashed yet.
              {stashShortcutLabel
                ? ` Press ${stashShortcutLabel} with a prompt in the composer to stash it.`
                : null}
            </li>
          ) : (
            entries.map((entry) => {
              const highlighted = highlightedEntry?.id === entry.id;
              const imageCount = entry.attachments.length;
              const fileCount = entry.files?.length ?? 0;
              const droppedCount = missingImageCount(entry);
              return (
                <li
                  key={entry.id}
                  data-stash-entry={entry.id}
                  data-highlighted={highlighted || undefined}
                  className={cn(
                    "group/se relative flex h-8.5 items-center gap-2 rounded-(--r-ctl) ps-2 pe-1.5",
                    highlighted && "bg-(--sel)",
                  )}
                  onMouseMove={() => {
                    if (highlightedId !== entry.id) setHighlightedId(entry.id);
                  }}
                  onFocus={() => setHighlightedId(entry.id)}
                >
                  <FileTextIcon className="size-3.25 shrink-0 text-muted-foreground" aria-hidden />
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground outline-none before:absolute before:inset-0 before:rounded-(--r-ctl) focus-visible:before:outline-2 focus-visible:before:-outline-offset-2 focus-visible:before:outline-ring"
                    data-stash-restore={entry.id}
                    aria-label={`Restore stashed prompt: ${stashEntrySnippet(entry)}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onRestore(entry)}
                  >
                    {stashEntrySnippet(entry)}
                  </button>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {entry.pendingImageCount ? (
                      <span>
                        saving {entry.pendingImageCount} image
                        {entry.pendingImageCount === 1 ? "" : "s"}…
                      </span>
                    ) : droppedCount > 0 ? (
                      <span className="text-warning-foreground">
                        {droppedCount} image
                        {droppedCount === 1 ? "" : "s"} dropped
                      </span>
                    ) : null}
                    {imageCount > 0 ? (
                      <span className="inline-flex items-center gap-0.75 tabular-nums">
                        <ImageIcon className="size-3.25" aria-hidden />
                        {imageCount}
                      </span>
                    ) : null}
                    {fileCount > 0 ? (
                      <span className="inline-flex items-center gap-0.75 tabular-nums">
                        <FileIcon className="size-3.25" aria-hidden />
                        {fileCount}
                      </span>
                    ) : null}
                    <time dateTime={entry.createdAt} className="shrink-0 tabular-nums max-sm:hidden">
                      <RelativeTime timestamp={entry.createdAt} />
                    </time>
                    {highlighted ? (
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        className="relative z-10"
                        aria-label="Delete stashed prompt"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => onDelete(entry)}
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </ScrollArea>
      <div className="mt-0.75 flex items-center gap-1.5 border-t border-border px-2 pt-2 pb-1.5 text-2xs text-muted-foreground">
        <Kbd>↑↓</Kbd> choose
        <Kbd>Enter</Kbd> restore
        <Kbd>{deleteShortcutLabel}</Kbd> delete
        <Kbd>Esc</Kbd> close
      </div>
    </div>
  );
});
