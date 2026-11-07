import { Check, Copy } from "lucide";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { observeResize } from "~/lib/observeResize";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

/**
 * Base UI's ScrollArea reads four layout sizes per instance as it mounts, and most tables fit
 * their lane. A table gets one only once a resize observation finds it wider than the lane.
 */
function TableScroll({ children }: { children: ReactNode }) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- observes the table's and the lane's widths to swap in the scroll area before paint
  useEffect(() => {
    const lane = laneRef.current;
    const table = lane?.querySelector("table");
    if (overflows || !lane || !table) return;
    const widths = new Map<Element, number>();
    return observeResize([lane, table], (entries) => {
      for (const entry of entries) {
        widths.set(entry.target, entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width);
      }
      if ((widths.get(table) ?? 0) > (widths.get(lane) ?? Infinity) + 0.5) setOverflows(true);
    });
  }, [overflows]);
  if (overflows) {
    return (
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        {children}
      </ScrollArea>
    );
  }
  return (
    <div ref={laneRef} className="w-full max-w-full overflow-x-auto">
      {children}
    </div>
  );
}

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<"markdown" | "csv">({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const copyLabel = copied ? "Copied" : "Copy table";

  const handleCopy = (format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyToClipboard(
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table),
      format,
    );
  };

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <TableScroll>
        <table {...props}>{children}</table>
      </TableScroll>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-end select-none">
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              <MorphIcon className="size-3" icon={copied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
