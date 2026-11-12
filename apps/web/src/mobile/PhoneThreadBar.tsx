import { ArrowLeftIcon, ChevronDownIcon, EllipsisIcon, SquareMenuIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import { Button } from "../components/ui/button";
import { GridPaneRenameInput } from "../components/ui/grid-pane";
import {
  PHONE_TABS_CHEVRON_CLS,
  PHONE_TABS_COUNT_CLS,
  PHONE_TABS_MARK_CLS,
  PHONE_TABS_TRIGGER_CLS,
  PHONE_THREAD_BAR_BREADCRUMB_CLS,
  PHONE_THREAD_BAR_CLS,
  PHONE_THREAD_BAR_TITLE_CLS,
} from "../components/ui/thread-header-recipes";
import { textDirection } from "../textDirection";

/**
 * The phone's thread header, one row: back to the rail, one button holding the active tab's mark,
 * title and the pane's tab count (it opens the pane's tabs), then the thread's details and menu.
 */
export function PhoneThreadBar({
  title,
  mark,
  tabCount,
  onOpenTabs,
  tabsTriggerRef,
  renaming,
  renameValue,
  onChangeRename,
  onCommitRename,
  onCancelRename,
  detailsOpen,
  onToggleDetails,
  onDetailsRef,
  menuButtonRef,
  onOpenMenu,
  onBack,
}: {
  title: string;
  /** The active tab's mark: a thread's status glyph or a surface's icon. */
  mark: ReactNode;
  tabCount: number;
  /** Absent while the pane holds no tab, so there is nothing to list. */
  onOpenTabs?: (() => void) | undefined;
  tabsTriggerRef?: RefObject<HTMLButtonElement | null> | undefined;
  renaming: boolean;
  renameValue: string;
  onChangeRename: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  detailsOpen: boolean;
  onToggleDetails?: (() => void) | undefined;
  onDetailsRef?: ((node: HTMLButtonElement | null) => void) | undefined;
  menuButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
  onOpenMenu?: (() => void) | undefined;
  onBack: () => void;
}) {
  const label = (
    <>
      {mark === null ? null : (
        <span data-phone-thread-status="" className={PHONE_TABS_MARK_CLS}>
          {mark}
        </span>
      )}
      <span
        dir={textDirection(title)}
        data-phone-bar-title=""
        className={PHONE_THREAD_BAR_TITLE_CLS}
      >
        {title}
      </span>
    </>
  );
  return (
    <div data-phone-thread-bar="" className={PHONE_THREAD_BAR_CLS}>
      <Button variant="ghost" size="icon" aria-label="Back to threads" onClick={onBack}>
        <ArrowLeftIcon className="size-4" />
      </Button>
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center">
          <GridPaneRenameInput
            value={renameValue}
            onChange={onChangeRename}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        </div>
      ) : onOpenTabs === undefined ? (
        <div className={PHONE_THREAD_BAR_BREADCRUMB_CLS}>{label}</div>
      ) : (
        <button
          ref={tabsTriggerRef}
          type="button"
          data-phone-tabs-trigger=""
          aria-haspopup="dialog"
          aria-label={`${title}, ${tabCount} ${tabCount === 1 ? "tab" : "tabs"}`}
          onClick={onOpenTabs}
          className={PHONE_TABS_TRIGGER_CLS}
        >
          {label}
          <span data-phone-tabs-count="" aria-hidden className={PHONE_TABS_COUNT_CLS}>
            {tabCount}
          </span>
          <ChevronDownIcon aria-hidden className={PHONE_TABS_CHEVRON_CLS} />
        </button>
      )}
      {onToggleDetails === undefined ? null : (
        <Button
          ref={onDetailsRef}
          variant="ghost"
          size="icon"
          aria-label="Thread details"
          aria-pressed={detailsOpen}
          onClick={onToggleDetails}
        >
          <SquareMenuIcon className="size-4" />
        </Button>
      )}
      {onOpenMenu === undefined ? null : (
        <Button
          ref={menuButtonRef}
          variant="ghost"
          size="icon"
          aria-label={`Thread actions for ${title}`}
          aria-haspopup="menu"
          onClick={onOpenMenu}
        >
          <EllipsisIcon className="size-4" />
        </Button>
      )}
    </div>
  );
}
