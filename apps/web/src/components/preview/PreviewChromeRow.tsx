import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  RotateCw,
  SquareMousePointer,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { PreviewAddressLabel } from "~/components/ui/preview-address-label";
import { previewAddressSecurity, previewAddressSecurityLabel } from "./previewAddressSecurity";

interface Props {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  /** Owned by the caller so its shortcut handler can focus the address bar directly. */
  urlInputRef: RefObject<HTMLInputElement | null>;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onSubmit: (url: string) => void;
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  onDeviceSize?: (() => void) | undefined;
  deviceSizeActive?: boolean | undefined;
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  pickDisabledReason?: string | undefined;
  onToggleFullScreen?: (() => void) | undefined;
  fullScreen?: boolean | undefined;
  /**
   * Renders the overflow menu. It receives the toolbar actions that have no button of their own
   * so the menu can list them first, keeping every action reachable in a narrow panel.
   */
  renderMenu?: ((actions: readonly ToolbarOverflowAction[]) => ReactNode) | undefined;
  leadingActions?: ReactNode;
}

export interface ToolbarOverflowAction {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean | undefined;
}

const NOOP = () => {};

function addressParts(url: string): { host: string; path: string } | null {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}${parsed.hash}` };
  } catch {
    return url.length > 0 ? { host: url, path: "" } : null;
  }
}

export function PreviewChromeRow({
  url,
  loading,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  urlInputRef: inputRef,
  onBack,
  onForward,
  onRefresh,
  onSubmit,
  onOpenInBrowser,
  onCapture,
  captureDisabled,
  recording,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  onDeviceSize,
  deviceSizeActive,
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  onToggleFullScreen,
  fullScreen,
  renderMenu,
  leadingActions,
}: Props) {
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);
  const parts = addressParts(url);
  const security = previewAddressSecurity(url);
  const showParts = !inputFocused && parts !== null;

  // Only annotate and full screen keep a button: the address field needs the width, and a
  // recording keeps a stop button while it runs so it cannot be forgotten.
  const overflowActions: ToolbarOverflowAction[] = [];
  if (onOpenInBrowser) {
    overflowActions.push({
      id: "open-external",
      label: "Open in system browser",
      onSelect: onOpenInBrowser,
    });
  }
  if (onDeviceSize) {
    overflowActions.push({
      id: "device-toolbar",
      label: deviceSizeActive ? "Hide device toolbar" : "Show device toolbar",
      onSelect: onDeviceSize,
    });
  }
  if (onCapture && !recording) {
    overflowActions.push(
      {
        id: "capture-screenshot",
        label: "Capture screenshot",
        onSelect: () => onCapture(false),
        disabled: captureDisabled,
      },
      {
        id: "record-screen",
        label: "Record screen",
        onSelect: () => onCapture(true),
        disabled: captureDisabled,
      },
    );
  }
  if (onPictureInPicture) {
    overflowActions.push({
      id: "float-preview",
      label: pictureInPicture ? "Close floating preview" : "Float preview over chat",
      onSelect: onPictureInPicture,
      disabled: pictureInPictureDisabled,
    });
  }

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next.length === 0) return;
    onSubmit(next);
    inputRef.current?.blur();
  };

  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="flex h-10 min-h-10 shrink-0 items-center gap-0.5 border-b border-border bg-[var(--rail)] px-1.5"
        data-surface-subheader
      >
        <div className="flex items-center" role="group" aria-label="Navigation">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-[var(--houston)]"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label="Back"
                  type="button"
                />
              }
            >
              <ChevronLeft className="size-[15px]" />
            </TooltipTrigger>
            <TooltipPopup>Back</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-[var(--houston)]"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label="Forward"
                  type="button"
                />
              }
            >
              <ChevronRight className="size-[15px]" />
            </TooltipTrigger>
            <TooltipPopup>Forward</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-[var(--houston)]"
                  onClick={refreshDisabled ? NOOP : onRefresh}
                  disabled={refreshDisabled}
                  aria-label={loading ? "Stop" : "Reload"}
                  type="button"
                />
              }
            >
              {loading ? (
                <RefreshIcon className="size-[15px]" refreshing />
              ) : (
                <RotateCw className="size-[15px]" />
              )}
            </TooltipTrigger>
            <TooltipPopup>{loading ? "Loading…" : "Reload"}</TooltipPopup>
          </Tooltip>
        </div>

        {leadingActions}

        <div className="relative mx-1 flex h-7 min-w-0 flex-1 items-center rounded-md bg-[var(--field)] px-2.5 font-mono text-xs">
          {showParts ? (
            <span
              aria-hidden
              className="pointer-events-none flex min-w-0 flex-1 items-center overflow-hidden"
            >
              {security ? (
                <PreviewAddressLabel
                  label={previewAddressSecurityLabel(security)}
                  tone={security === "not-secure" ? "warning" : "neutral"}
                />
              ) : null}
              {/* The path gives way first, then the host, each ending in an ellipsis. */}
              <span className="max-w-full shrink-0 truncate text-[var(--houston)]">
                {parts.host}
              </span>
              <span className="min-w-0 truncate text-[var(--t1)]">{parts.path}</span>
            </span>
          ) : null}
          <input
            ref={inputRef}
            value={inputFocused ? draft : url}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => {
              setDraft(url);
              setInputFocused(true);
              queueMicrotask(() => inputRef.current?.select());
            }}
            onBlur={() => setInputFocused(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(event);
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(url);
                inputRef.current?.blur();
              }
            }}
            placeholder="Search or enter URL"
            aria-label="Search or enter URL"
            data-workspace-focus-default
            spellCheck={false}
            disabled={inputDisabled}
            data-preview-url-input
            className={cn(
              "absolute inset-0 h-full w-full rounded-md bg-transparent px-2.5 font-mono text-xs text-[var(--t1)] outline-none placeholder:text-[var(--houston)]",
              showParts && "text-transparent caret-transparent selection:bg-transparent",
            )}
          />
        </div>

        {onToggleFullScreen ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={fullScreen ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7"
                  onClick={onToggleFullScreen}
                  aria-label={fullScreen ? "Exit full screen" : "Full screen"}
                  aria-pressed={fullScreen ? "true" : "false"}
                  type="button"
                />
              }
            >
              {fullScreen ? (
                <Minimize2 className="size-[15px]" />
              ) : (
                <Maximize2 className="size-[15px]" />
              )}
            </TooltipTrigger>
            <TooltipPopup>{fullScreen ? "Exit full screen" : "Full screen"}</TooltipPopup>
          </Tooltip>
        ) : null}
        {onPickElement ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pickActive ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7 text-[var(--houston)]"
                  onClick={onPickElement}
                  disabled={pickDisabled}
                  aria-label={pickActive ? "Cancel annotation" : "Annotate preview"}
                  aria-pressed={pickActive ? "true" : "false"}
                  type="button"
                />
              }
            >
              <SquareMousePointer className={cn("size-[15px]", pickActive && "text-[var(--t1)]")} />
            </TooltipTrigger>
            <TooltipPopup>
              {pickDisabled && pickDisabledReason
                ? pickDisabledReason
                : pickActive
                  ? "Cancel annotation (Esc)"
                  : "Annotate elements, regions, and drawings"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onCapture && recording ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="secondary"
                  size="icon"
                  className="relative size-7 text-[var(--houston)]"
                  onClick={() => onCapture(false)}
                  aria-label="Stop recording"
                  type="button"
                />
              }
            >
              <span className="size-2 animate-status-pulse rounded-full bg-destructive motion-safe:animate-status-pulse" />
            </TooltipTrigger>
            <TooltipPopup>Stop recording</TooltipPopup>
          </Tooltip>
        ) : null}
        {renderMenu?.(overflowActions)}
      </form>
      <div
        aria-hidden
        data-loading={loading}
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </div>
  );
}
