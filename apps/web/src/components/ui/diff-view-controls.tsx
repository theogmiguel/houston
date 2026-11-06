import {
  Columns2Icon,
  EllipsisIcon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  PilcrowIcon,
  TextWrapIcon,
} from "lucide-react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { type ReactNode, useRef, useState } from "react";

import { MorphIcon } from "~/components/MorphIcon";

import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./menu";
import { RefreshIcon } from "./refresh-icon";
import { Separator } from "./separator";
import { Toggle } from "./toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * The diff panel's view controls: layout, wrap, whitespace, file tree and fold-all.
 * Place it inside an `@container/diff-toolbar` row: narrow rows keep the layout toggle and move
 * the rest into an overflow menu. The 28rem fold-in point leaves room for the panel's scope
 * selector and close button beside it.
 */
export function DiffViewControls({
  diffLayout,
  onDiffLayoutChange,
  wordWrap,
  onWordWrapChange,
  ignoreWhitespace,
  onIgnoreWhitespaceChange,
  hasFiles,
  fileTreeOpen,
  onFileTreeOpenChange,
  allFilesCollapsed,
  onToggleAllFiles,
  refresh,
  testFileCount = 0,
  hideTestFiles = false,
  onHideTestFilesChange,
  menuExtra,
}: {
  diffLayout: "stacked" | "split";
  onDiffLayoutChange: (diffLayout: "stacked" | "split") => void;
  wordWrap: boolean;
  onWordWrapChange: (wordWrap: boolean) => void;
  ignoreWhitespace: boolean;
  onIgnoreWhitespaceChange: (ignoreWhitespace: boolean) => void;
  /** Fold-all and the file tree only mean something once there are files. */
  hasFiles: boolean;
  fileTreeOpen: boolean;
  onFileTreeOpenChange: (open: boolean) => void;
  allFilesCollapsed: boolean;
  onToggleAllFiles: () => void;
  refresh?: { refreshing: boolean; onRefresh: () => void } | undefined;
  testFileCount?: number;
  hideTestFiles?: boolean;
  onHideTestFilesChange?: (hidden: boolean) => void;
  /**
   * Entries the host adds to the one overflow menu, below the view controls that fold in when the
   * toolbar is narrow. Without them the menu exists only while the toolbar is narrow.
   */
  menuExtra?: ReactNode;
}) {
  // The menu is portaled out of the toolbar, so its container query cannot apply. A sentinel
  // inside the toolbar reports which side of the fold-in width the toolbar is on when it opens.
  const wideSentinelRef = useRef<HTMLSpanElement>(null);
  const [narrow, setNarrow] = useState(false);
  const measureNarrow = () => {
    const sentinel = wideSentinelRef.current;
    if (sentinel !== null) setNarrow(getComputedStyle(sentinel).display === "none");
  };
  const setDiffLayout = (value: unknown) => {
    if (value === "stacked" || value === "split") onDiffLayoutChange(value);
  };

  return (
    <>
      <div className="hidden items-center gap-1 @md/diff-toolbar:flex">
        {refresh && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={refresh.refreshing ? "Refreshing diff" : "Refresh diff"}
                  onClick={refresh.onRefresh}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={refresh.refreshing} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {refresh.refreshing ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {hasFiles && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={onToggleAllFiles}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      <div className="hidden @2xs/diff-toolbar:flex">
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={diffLayout === "split" ? "Stacked diff view" : "Split diff view"}
                variant="ghost"
                size="sm"
                pressed={diffLayout === "split"}
                onPressedChange={(pressed) => onDiffLayoutChange(pressed ? "split" : "stacked")}
              />
            }
          >
            <Columns2Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffLayout === "split" ? "Stacked view" : "Split view"}
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="hidden items-center gap-1 @md/diff-toolbar:flex">
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => onWordWrapChange(Boolean(pressed))}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={ignoreWhitespace}
                onPressedChange={(pressed) => onIgnoreWhitespaceChange(Boolean(pressed))}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
        {testFileCount > 0 && onHideTestFilesChange && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label="Hide test files"
                  variant="ghost"
                  size="sm"
                  pressed={hideTestFiles}
                  onPressedChange={(pressed) => onHideTestFilesChange(Boolean(pressed))}
                />
              }
            >
              <FlaskConicalOffIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {hideTestFiles
                ? `Show ${testFileCount} hidden test ${testFileCount === 1 ? "file" : "files"}`
                : "Hide test files"}
            </TooltipPopup>
          </Tooltip>
        )}
        {hasFiles && <Separator orientation="vertical" className="mx-0.5 h-3.5" />}
        {hasFiles && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => onFileTreeOpenChange(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      <span
        ref={wideSentinelRef}
        aria-hidden
        className="pointer-events-none hidden size-0 @md/diff-toolbar:block"
      />
      <DropdownMenu onOpenChange={(open) => open && measureNarrow()}>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Diff options"
              className={menuExtra ? undefined : "@md/diff-toolbar:hidden"}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {narrow ? (
            <>
              <DropdownMenuRadioGroup value={diffLayout} onValueChange={setDiffLayout}>
                <DropdownMenuRadioItem value="stacked">Stacked view</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="split">Split view</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              {refresh && (
                <DropdownMenuItem disabled={refresh.refreshing} onClick={refresh.onRefresh}>
                  Refresh diff
                </DropdownMenuItem>
              )}
              {hasFiles && (
                <DropdownMenuItem onClick={onToggleAllFiles}>
                  {allFilesCollapsed ? "Expand all files" : "Collapse all files"}
                </DropdownMenuItem>
              )}
              <DropdownMenuCheckboxItem
                checked={wordWrap}
                onCheckedChange={(checked) => onWordWrapChange(Boolean(checked))}
              >
                Wrap lines
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={ignoreWhitespace}
                onCheckedChange={(checked) => onIgnoreWhitespaceChange(Boolean(checked))}
              >
                Hide whitespace changes
              </DropdownMenuCheckboxItem>
              {testFileCount > 0 && onHideTestFilesChange && (
                <DropdownMenuCheckboxItem
                  checked={hideTestFiles}
                  onCheckedChange={(checked) => onHideTestFilesChange(Boolean(checked))}
                >
                  Hide test files
                </DropdownMenuCheckboxItem>
              )}
              {hasFiles && (
                <DropdownMenuCheckboxItem
                  checked={fileTreeOpen}
                  onCheckedChange={(checked) => onFileTreeOpenChange(Boolean(checked))}
                >
                  File tree
                </DropdownMenuCheckboxItem>
              )}
              {menuExtra ? <DropdownMenuSeparator /> : null}
            </>
          ) : null}
          {menuExtra}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
