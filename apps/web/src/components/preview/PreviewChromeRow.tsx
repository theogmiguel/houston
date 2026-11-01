import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  ExternalLink,
  MonitorSmartphone,
  PictureInPicture2,
  RotateCw,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useState } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

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
  trailingActions?: ReactNode;
  leadingActions?: ReactNode;
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
  trailingActions,
  leadingActions,
}: Props) {
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);
  const parts = addressParts(url);
  const showParts = !inputFocused && parts !== null;

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
                  className="size-7 text-[var(--t3)]"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label="Back"
                  type="button"
                />
              }
            >
              <ChevronLeft className="size-[15px]" strokeWidth={1.7} />
            </TooltipTrigger>
            <TooltipPopup>Back</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-[var(--t3)]"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label="Forward"
                  type="button"
                />
              }
            >
              <ChevronRight className="size-[15px]" strokeWidth={1.7} />
            </TooltipTrigger>
            <TooltipPopup>Forward</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-[var(--t3)]"
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
                <RotateCw className="size-[15px]" strokeWidth={1.7} />
              )}
            </TooltipTrigger>
            <TooltipPopup>{loading ? "Loading…" : "Reload"}</TooltipPopup>
          </Tooltip>
        </div>

        {leadingActions}

        <div className="relative mx-1 flex h-7 min-w-0 flex-1 items-center rounded-md bg-[var(--field)] px-2.5 font-mono text-xs">
          {showParts ? (
            <span aria-hidden className="pointer-events-none flex min-w-0 items-center truncate">
              <span className="shrink-0 text-[var(--t3)]">{parts.host}</span>
              <span className="truncate text-[var(--t1)]">{parts.path}</span>
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
              "absolute inset-0 h-full w-full rounded-md bg-transparent px-2.5 font-mono text-xs text-[var(--t1)] outline-none placeholder:text-[var(--t3)]",
              showParts && "text-transparent caret-transparent selection:bg-transparent",
            )}
          />
        </div>

        {onOpenInBrowser ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-[var(--t3)]"
                  onClick={onOpenInBrowser}
                  aria-label="Open in system browser"
                  type="button"
                />
              }
            >
              <ExternalLink className="size-[15px]" strokeWidth={1.7} />
            </TooltipTrigger>
            <TooltipPopup>Open in system browser</TooltipPopup>
          </Tooltip>
        ) : null}
        {onDeviceSize ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={deviceSizeActive ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7 text-[var(--t3)]"
                  onClick={onDeviceSize}
                  aria-label="Device size"
                  aria-pressed={deviceSizeActive ? "true" : "false"}
                  type="button"
                />
              }
            >
              <MonitorSmartphone className="size-[15px]" strokeWidth={1.7} />
            </TooltipTrigger>
            <TooltipPopup>{deviceSizeActive ? "Fit the panel" : "Device size"}</TooltipPopup>
          </Tooltip>
        ) : null}
        {onPickElement ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pickActive ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7 text-[var(--t3)]"
                  onClick={onPickElement}
                  disabled={pickDisabled}
                  aria-label={pickActive ? "Cancel annotation" : "Annotate preview"}
                  aria-pressed={pickActive ? "true" : "false"}
                  type="button"
                />
              }
            >
              <Crosshair className={cn("size-[15px]", pickActive && "text-[var(--t1)]")} strokeWidth={1.7} />
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
        {onCapture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={recording ? "secondary" : "ghost"}
                  size="icon"
                  className="relative size-7 text-[var(--t3)]"
                  onClick={(event) => onCapture(event.shiftKey)}
                  aria-label={recording ? "Stop recording" : "Capture screenshot"}
                  type="button"
                  disabled={captureDisabled}
                />
              }
            >
              <Camera className="size-[15px]" strokeWidth={1.7} />
              {recording ? (
                <span className="absolute right-1 top-1 size-1.5 animate-status-pulse rounded-full bg-destructive motion-safe:animate-status-pulse" />
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {recording ? "Stop recording" : "Screenshot · Shift-click to record"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onPictureInPicture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pictureInPicture ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7 text-[var(--t3)]"
                  onClick={onPictureInPicture}
                  aria-label={pictureInPicture ? "Close floating preview" : "Float preview over chat"}
                  aria-pressed={pictureInPicture ? "true" : "false"}
                  type="button"
                  disabled={pictureInPictureDisabled}
                />
              }
            >
              <PictureInPicture2 className="size-[15px]" strokeWidth={1.7} />
            </TooltipTrigger>
            <TooltipPopup>
              {pictureInPicture ? "Close floating preview" : "Float preview over chat"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {trailingActions}
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
