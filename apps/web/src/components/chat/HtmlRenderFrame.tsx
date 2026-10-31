import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { CircleAlertIcon, CodeXmlIcon, Maximize2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { observeResize } from "~/lib/observeResize";

const MIN_URL_LIFE_MS = 5 * 60_000;
const FRAME_HEAD_HEIGHT = 32;
const FRAME_BODY_PADDING = 12;

export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
}) {
  const { attachmentId, title } = props.htmlRender;
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const observeBox = (box: HTMLDivElement) => {
    const widthOf = (width: number) => Math.max(1, width - FRAME_BODY_PADDING * 2);
    setWidth(widthOf(box.clientWidth));
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(widthOf(entry.contentRect.width));
    });
  };
  // Client fonts can exceed the server-measured height and cause nested scrolling.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const fileName = htmlRenderFileName(title);
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName,
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  // The frame keeps the first URL it loads, so later mints do not reload the page.
  const [loaded, setLoaded] = useState<{ src: string; expiresAt: number } | null>(null);
  const assetUrl = useLongLivedAssetUrl(loaded === null ? props.environmentId : null, resource);
  if (loaded === null && assetUrl._tag === "Success") {
    setLoaded({ src: assetUrl.url, expiresAt: assetUrl.expiresAt });
  }
  const src = loaded?.src ?? null;
  const failed = loaded === null && assetUrl._tag === "Failure";
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const [expandedSrc, setExpandedSrc] = useState<string | null>(null);
  const { onFullscreenChange } = props;
  // Tied to the viewer's lifetime: unmounting while expanded must still release
  // the timeline's follow pin, which a close handler alone never reaches.
  const expanded = expandedSrc !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the parent's fullscreen pin while expanded and releases it on collapse or unmount
  useEffect(() => {
    if (!expanded) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expanded, onFullscreenChange]);

  const openFullScreen = async () => {
    const url =
      loaded !== null && loaded.expiresAt - Date.now() > MIN_URL_LIFE_MS
        ? src
        : await refresh().catch(() => null);
    if (url !== null) setExpandedSrc(url);
    else
      toastManager.add({
        type: "error",
        title: "Page unavailable",
        description: "Reconnect to the environment and try again.",
      });
  };

  return (
    <div
      ref={observeBox}
      className="relative"
      style={{ height: height + FRAME_HEAD_HEIGHT + FRAME_BODY_PADDING * 2 }}
    >
      <div className="flex size-full flex-col overflow-hidden rounded-lg border border-border bg-(--pane)">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-(--pane-head) ps-2.5 pe-1 text-(--t2)">
          <CodeXmlIcon aria-hidden className="size-3.25 shrink-0 text-(--t3)" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{fileName}</span>
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-sm bg-(--field) px-1.5 text-2xs font-medium text-(--t2)">
            Interactive
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Open full screen"
                  size="icon"
                  variant="ghost"
                  onClick={openFullScreen}
                />
              }
            >
              <Maximize2Icon />
            </TooltipTrigger>
            <TooltipPopup side="left">Open full screen</TooltipPopup>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 p-3">
          {src !== null ? (
            <div className="relative size-full">
              <HtmlRenderDocument
                src={src}
                title={title}
                threadRef={props.threadRef}
                className="block size-full"
                onContentHeight={setContentHeight}
                onFullscreenChange={onFullscreenChange}
              />
            </div>
          ) : failed ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-1 px-3 py-8 text-center">
              <CircleAlertIcon aria-hidden className="size-3.75 text-(--t3)" />
              <span className="font-semibold text-headline">Page unavailable</span>
              <span className="text-(--t2) text-xs">
                Reconnect to the environment and try again.
              </span>
            </div>
          ) : null}
        </div>
      </div>
      {expandedSrc !== null ? (
        <HtmlRenderDialog
          src={expandedSrc}
          title={title}
          threadRef={props.threadRef}
          onClose={() => setExpandedSrc(null)}
        />
      ) : null}
    </div>
  );
}
