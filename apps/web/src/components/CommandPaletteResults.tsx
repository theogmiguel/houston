import { type ResolvedKeybindingsConfig } from "@houston-app/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteRow,
  type CommandPaletteSubmenuItem,
  COMMAND_PALETTE_LIST_BOTTOM_INSET_PX,
  snapCommandPaletteListHeight,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandShortcut,
} from "./ui/command";
import { getVirtualizedScrollFadeClassName } from "./ui/scroll-area";
import { ProjectPinButton } from "./ProjectPinButton";
import { SearchMatchHintLine, ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

function CommandPaletteEmptyState(props: { emptyStateMessage?: string; isActionsOnly: boolean }) {
  return (
    <div className="py-10 text-center text-sm text-muted-foreground">
      {props.emptyStateMessage ??
        (props.isActionsOnly
          ? "No matching actions."
          : "No matching commands, projects, or threads.")}
    </div>
  );
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          {group.label ? <CommandGroupLabel>{group.label}</CommandGroupLabel> : null}
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

export function scrollCommandPaletteRowIntoView(list: LegendListRef | null, rowIndex: number) {
  const element = list?.getState?.().elementAtIndex(rowIndex);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "nearest" });
    return;
  }
  void list?.scrollIndexIntoView?.({ index: rowIndex, animated: false });
}

interface CommandPaletteVirtualizedResultsProps extends Omit<CommandPaletteResultsProps, "groups"> {
  rows: ReadonlyArray<CommandPaletteRow>;
  listRef: RefObject<LegendListRef | null>;
}

/**
 * Caps the list so it ends under a whole row. The palette's height is capped by its popup, and a
 * list taller than what is left would cut its last row in half; this measures the rows and returns
 * the viewport height that ends at the last one that fits.
 */
function useWholeRowViewportHeight(listRef: RefObject<LegendListRef | null>, rowCount: number) {
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- measures rendered row geometry, which only exists after layout
  useEffect(() => {
    const scroller = listRef.current?.getScrollableNode?.();
    if (!(scroller instanceof HTMLElement)) return;
    const content = scroller.firstElementChild;
    const wrapper = scroller.closest<HTMLElement>('[data-slot="command-list"]');
    const popup = scroller.closest<HTMLElement>('[data-slot="command-dialog-popup"]');
    const viewport = popup?.parentElement;
    if (!(content instanceof HTMLElement) || !wrapper || !popup || !viewport) return;
    const measure = () => {
      // Layout pixels: the popup scales while it opens, which distorts client rects.
      const scale =
        scroller.offsetHeight > 0
          ? scroller.getBoundingClientRect().height / scroller.offsetHeight
          : 1;
      const viewportStyle = getComputedStyle(viewport);
      const popupLimit = Math.min(
        Number.parseFloat(getComputedStyle(popup).maxHeight) || Number.POSITIVE_INFINITY,
        viewport.clientHeight -
          Number.parseFloat(viewportStyle.paddingTop) -
          Number.parseFloat(viewportStyle.paddingBottom),
      );
      const chrome = popup.offsetHeight - wrapper.offsetHeight;
      const top = scroller.getBoundingClientRect().top;
      // The list wraps its rows in one or two single-child containers.
      let rowParent: Element = content;
      while (rowParent.children.length === 1 && rowParent.firstElementChild?.firstElementChild) {
        rowParent = rowParent.firstElementChild;
      }
      const rowBottoms = Array.from(rowParent.children).flatMap((row) =>
        row instanceof HTMLElement && row.offsetHeight > 0
          ? [(row.getBoundingClientRect().bottom - top) / scale + scroller.scrollTop]
          : [],
      );
      const next = snapCommandPaletteListHeight({
        rowBottoms,
        contentHeightPx: scroller.scrollHeight,
        availablePx: popupLimit - chrome,
      });
      setMaxHeight((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(popup);
    return () => observer.disconnect();
  }, [listRef, rowCount]);
  return maxHeight;
}

/** Pass flat items with virtualized to Command, scroll highlights via listRef, and handle Enter for
 * unmounted rows. */
export function CommandPaletteVirtualizedResults(props: CommandPaletteVirtualizedResultsProps) {
  const { listRef } = props;
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });
  const maxHeight = useWholeRowViewportHeight(listRef, props.rows.length);
  const updateScrollFade = () => {
    const scrollElement = listRef.current?.getScrollableNode?.();
    if (!(scrollElement instanceof HTMLElement)) return;
    const top = scrollElement.scrollTop > 1;
    const bottom =
      scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop > 1;
    setScrollFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };

  if (props.rows.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandListVirtualized>
      <LegendList<CommandPaletteRow>
        ref={listRef}
        data={props.rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        extraData={props.highlightedItemValue}
        renderItem={({ item: row }) =>
          row.kind === "label" ? (
            <div className={row.first ? undefined : "pt-1.5"}>
              <CommandListHeading>{row.label}</CommandListHeading>
            </div>
          ) : row.itemIndex === null ? (
            <DisabledCommandPaletteResultRow item={row.item} />
          ) : (
            <CommandPaletteResultRow
              index={row.itemIndex}
              item={row.item}
              keybindings={props.keybindings}
              isActive={props.highlightedItemValue === row.item.value}
              onExecuteItem={props.onExecuteItem}
            />
          )
        }
        estimatedItemSize={40}
        drawDistance={400}
        onLayout={updateScrollFade}
        onScroll={updateScrollFade}
        contentContainerClassName="px-2"
        {...(maxHeight === undefined
          ? {}
          : { style: { maxHeight, marginBottom: COMMAND_PALETTE_LIST_BOTTOM_INSET_PX } })}
        className={cn(
          "min-h-0 scroll-py-6 overflow-x-hidden overscroll-y-contain pt-2 pb-4 [&::-webkit-scrollbar-track]:my-2",
          getVirtualizedScrollFadeClassName(scrollFade, { tall: true }),
        )}
      />
    </CommandListVirtualized>
  );
}

export function CommandPaletteTitleIcon(props: { children: ReactNode }) {
  return <span className="flex h-5 shrink-0 items-center self-start pt-0.5">{props.children}</span>;
}

function CommandPaletteTitle({
  item,
}: {
  item: Pick<CommandPaletteActionItem | CommandPaletteSubmenuItem, "title">;
}) {
  const { title } = item;
  return (
    <span className="truncate" dir={typeof title === "string" ? textDirection(title) : undefined}>
      {title}
    </span>
  );
}

/**
 * Project and environment for a thread row whose second line shows a message
 * snippet or match hint instead, so similar rows can still be told apart.
 */
function ThreadRowContext({
  item,
}: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  if (!item.threadSearch || !(item.threadContentMatch || item.matchHint)) return null;
  // A "Project: …" hint already names the project.
  const context = [item.threadSearch.projectTitle, item.threadSearch.environmentLabel]
    .filter((part) => part && part !== item.matchHint?.text)
    .join(" · ");
  return context ? (
    <span className="max-w-[45%] shrink-0 truncate text-muted-foreground/70 text-xs">
      {context}
    </span>
  ) : null;
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      <CommandPaletteTitleIcon>{props.item.icon}</CommandPaletteTitleIcon>
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <CommandPaletteTitle item={props.item} />
            <ThreadRowContext item={props.item} />
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : props.item.matchHint ? (
            <SearchMatchHintLine hint={props.item.matchHint} />
          ) : props.item.description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">
              {props.item.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <CommandPaletteTitle item={props.item} />
        </span>
      )}
      {props.item.titleTrailingContent}
    </div>
  );
}

function CommandPaletteResultRow(props: {
  index?: number;
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      {...(props.index === undefined ? {} : { index: props.index })}
      value={props.item.value}
      active={props.isActive}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      <CommandPaletteTitleIcon>{props.item.icon}</CommandPaletteTitleIcon>
      {props.item.description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <CommandPaletteTitle item={props.item} />
            <ThreadRowContext item={props.item} />
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : props.item.matchHint ? (
            <SearchMatchHintLine hint={props.item.matchHint} />
          ) : props.item.description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">
              {props.item.description}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <CommandPaletteTitle item={props.item} />
        </span>
      )}
      {props.item.titleTrailingContent}
      {props.item.kind === "action" && props.item.pin ? (
        <ProjectPinButton
          name={props.item.pin.name}
          pinned={props.item.pin.pinned}
          onToggle={props.item.pin.toggle}
          shortcutLabel={shortcutLabelForCommand(props.keybindings, "thread.pin")}
        />
      ) : null}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
      ) : null}
    </CommandItem>
  );
}
