import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

const GroupedRows = createContext(false);

/** Groups may span virtualized timeline items. Each part owns its trailing space. */
export function WorkLogBlock({
  layout = "standalone",
  continues = false,
  children,
}: {
  layout?: "standalone" | "group-header" | "group-content";
  continues?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={
        continues || layout === "group-header"
          ? "pb-0"
          : layout === "group-content"
            ? "pb-1"
            : "pb-2"
      }
    >
      {children}
    </div>
  );
}

export function WorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col">{children}</div>
    </GroupedRows>
  );
}

type RowContent = {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
};

function WorkLogLine({ icon, label, trailing, wrapLabel }: RowContent) {
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 gap-2 text-body text-(--t2) select-none [&_*]:select-none",
        wrapLabel ? "items-start py-0.5" : "items-center",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {icon ? (
          <span className="flex size-3.5 shrink-0 items-center justify-center text-(--t3) [&_svg]:size-3.5">
            {icon}
          </span>
        ) : null}
        <div className={cn("min-w-0 flex-1", !wrapLabel && "truncate [&_*]:whitespace-nowrap")}>
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

function useRowClassName(interactive: boolean) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-(--r-ctl) px-2 text-left transition-colors",
    grouped ? "py-0" : "py-0.5",
    interactive && "hover:bg-(--hover)",
    interactive && interactionClassName,
  );
}

export function WorkLogButton({
  icon,
  label,
  trailing,
  wrapLabel = false,
  ...buttonProps
}: RowContent & Omit<ComponentProps<"button">, "className" | "style" | "children">) {
  const className = useRowClassName(true);
  return (
    <button {...buttonProps} type="button" className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
    </button>
  );
}

/** Div disclosure permits selectable detail and nested actions. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  wrapLabel = false,
  children,
  ...rowProps
}: RowContent & Omit<ComponentProps<"div">, "className" | "style">) {
  const className = useRowClassName(rowProps.onClick !== undefined);
  return (
    <div {...rowProps} className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
      {children}
    </div>
  );
}

const LIVE_EDGE_PX = 4;

export function WorkLogDetails({
  children,
  kind = "text",
  followLive = false,
}: {
  children: ReactNode;
  kind?: "text" | "panel" | "media";

  followLive?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pins the scroller's scrollTop to the bottom after each commit while following live output
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (followLive && atLiveEdgeRef.current && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });
  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX;
      }}
      className={cn(
        "cursor-auto",
        kind === "text"
          ? "ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
          : kind === "panel"
            ? "mt-0.5 mb-1.5 pb-2"
            : "mt-1",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
