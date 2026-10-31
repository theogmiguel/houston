import type { ScopedThreadRef } from "@t3tools/contracts";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

export function HtmlRenderDialog(props: {
  readonly src: string;
  readonly title: string;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileName = htmlRenderFileName(props.title);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1"
        initialFocus={closeButtonRef}
      >
        <DialogTitle className="sr-only">Expanded {props.title} preview</DialogTitle>
        <div className="dialog-glass flex w-[min(92vw,72rem)] flex-col overflow-hidden rounded-xl">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border ps-3.5 pe-1 text-(--t2)">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{fileName}</span>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                aria-label="Zoom out"
                size="icon"
                variant="ghost"
                disabled={zoom === MIN_ZOOM}
                onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))}
              >
                <MinusIcon />
              </Button>
              <span className="w-[38px] text-center font-mono text-xs tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                aria-label="Zoom in"
                size="icon"
                variant="ghost"
                disabled={zoom === MAX_ZOOM}
                onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}
              >
                <PlusIcon />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setZoom(1)}>
                Reset zoom
              </Button>
            </div>
            <Button
              ref={closeButtonRef}
              aria-label="Close"
              size="icon"
              variant="ghost"
              onClick={props.onClose}
            >
              <XIcon />
            </Button>
          </div>
          <div className="h-[min(86vh,calc(100vh-160px))] overflow-auto overscroll-contain bg-(--pane) p-4 [container-type:size]">
            <div className="h-[100cqh] w-[100cqw]" style={{ zoom }}>
              <HtmlRenderDocument
                src={props.src}
                title={props.title}
                threadRef={props.threadRef}
                className="block size-full"
              />
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
