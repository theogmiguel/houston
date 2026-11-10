import { ArrowLeftIcon, EllipsisIcon, SquareMenuIcon } from "lucide-react";
import type { RefObject } from "react";

import type { ThreadStatusPill } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import { GridPaneRenameInput } from "../components/ui/grid-pane";
import {
  PHONE_THREAD_BAR_BREADCRUMB_CLS,
  PHONE_THREAD_BAR_CLS,
  PHONE_THREAD_BAR_TITLE_CLS,
} from "../components/ui/thread-header-recipes";
import { ThreadStateGlyph } from "../components/ui/thread-state-glyph";
import { textDirection } from "../textDirection";

/** The phone's thread header: back to the rail, the thread's title, details and its menu. */
export function PhoneThreadBar({
  title,
  status,
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
  status: ThreadStatusPill | null;
  renaming: boolean;
  renameValue: string;
  onChangeRename: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  detailsOpen: boolean;
  onToggleDetails?: (() => void) | undefined;
  onDetailsRef?: ((node: HTMLButtonElement | null) => void) | undefined;
  menuButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
  onOpenMenu: () => void;
  onBack: () => void;
}) {
  return (
    <div data-phone-thread-bar="" className={PHONE_THREAD_BAR_CLS}>
      <Button variant="ghost" size="icon" aria-label="Back to threads" onClick={onBack}>
        <ArrowLeftIcon className="size-4" />
      </Button>
      {status === null ? null : (
        <span
          role="img"
          aria-label={status.label}
          data-phone-thread-status=""
          className="inline-grid size-3.5 shrink-0 place-items-center"
        >
          <ThreadStateGlyph state={status.state} colored />
        </span>
      )}
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center">
          <GridPaneRenameInput
            value={renameValue}
            onChange={onChangeRename}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        </div>
      ) : (
        <div className={PHONE_THREAD_BAR_BREADCRUMB_CLS}>
          <h1 dir={textDirection(title)} className={PHONE_THREAD_BAR_TITLE_CLS}>
            {title}
          </h1>
        </div>
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
    </div>
  );
}
