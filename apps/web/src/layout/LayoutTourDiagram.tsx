import {
  ArrowLeftRightIcon,
  FileDiffIcon,
  MessageSquareIcon,
  SquareTerminalIcon,
} from "lucide-react";

import { Kbd, KbdGroup } from "../components/ui/kbd";

export type LayoutTourLesson = "tabs" | "split" | "overview" | "keys";

function DiagramPane({ tabs = ["Chat"] }: { tabs?: readonly string[] }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden rounded-[var(--r-ctl)] border border-(--divider) bg-(--pane) p-2">
      <div className="flex w-max gap-1">
        {tabs.map((tab) => {
          const Icon =
            tab === "Terminal"
              ? SquareTerminalIcon
              : tab === "Diff"
                ? FileDiffIcon
                : MessageSquareIcon;
          return (
            <span
              key={tab}
              className="flex h-5 items-center gap-1 rounded-[var(--r-badge)] bg-hover px-1.5 text-caption text-muted-foreground"
            >
              <Icon className="size-3" />
              {tab}
            </span>
          );
        })}
      </div>
      <div className="h-1 w-2/3 shrink-0 rounded-full bg-foreground/15" />
      <div className="h-1 w-1/2 shrink-0 rounded-full bg-foreground/10" />
    </div>
  );
}

/** CSS diagrams of a lesson, drawn with the same tabs and keycaps as the workspace. */
export function LayoutTourDiagram({ lesson }: { lesson: LayoutTourLesson }) {
  return (
    <div
      aria-hidden
      inert
      className="relative flex h-32 items-stretch gap-1.5 overflow-hidden rounded-[var(--r-ctl)] bg-(--field) p-3"
    >
      {lesson === "tabs" ? (
        <DiagramPane tabs={["Chat", "Terminal", "Diff"]} />
      ) : lesson === "split" ? (
        <>
          <DiagramPane />
          <DiagramPane tabs={["Diff"]} />
        </>
      ) : lesson === "overview" ? (
        <div className="flex w-full flex-col justify-center gap-1.5">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex h-7 gap-1.5">
              {[0, 1, 2].map((column) => (
                <div
                  key={column}
                  className="flex flex-1 items-center rounded-[var(--r-badge)] border border-(--divider) bg-(--pane) px-2"
                >
                  <span className="h-1 w-2/3 rounded-full bg-foreground/15" />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-[1.5] flex-col gap-1.5">
            <DiagramPane />
            <DiagramPane tabs={["Terminal"]} />
          </div>
          <DiagramPane tabs={["Diff"]} />
        </>
      )}
      {lesson === "split" ? (
        <ArrowLeftRightIcon className="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
      ) : null}
    </div>
  );
}

export function LayoutTourKeys({ modifiers }: { modifiers: string }) {
  return (
    <div aria-hidden className="flex justify-center py-1">
      <KbdGroup>
        <Kbd>{modifiers}</Kbd>
        <Kbd>O</Kbd>
      </KbdGroup>
    </div>
  );
}
