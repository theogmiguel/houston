import { FileDiffIcon, MessageSquareIcon, SquareTerminalIcon } from "lucide-react";

import { Kbd, KbdGroup } from "../components/ui/kbd";
import {
  LayoutDiagramCell,
  LayoutDiagramColumn,
  LayoutDiagramLine,
  LayoutDiagramPane,
  LayoutDiagramStage,
  LayoutDiagramSwap,
  LayoutDiagramTab,
} from "../components/ui/layout-overlay";

export type LayoutTourLesson = "tabs" | "split" | "overview" | "keys";

function DiagramPane({ tabs = ["Chat"] }: { tabs?: readonly string[] }) {
  return (
    <LayoutDiagramPane>
      <div className="flex w-max gap-1">
        {tabs.map((tab) => {
          const Icon =
            tab === "Terminal"
              ? SquareTerminalIcon
              : tab === "Diff"
                ? FileDiffIcon
                : MessageSquareIcon;
          return (
            <LayoutDiagramTab key={tab}>
              <Icon className="size-3" />
              {tab}
            </LayoutDiagramTab>
          );
        })}
      </div>
      <LayoutDiagramLine />
      <LayoutDiagramLine tone="faint" size="half" />
    </LayoutDiagramPane>
  );
}

/** CSS diagrams of a lesson, drawn with the same tabs and keycaps as the workspace. */
export function LayoutTourDiagram({ lesson }: { lesson: LayoutTourLesson }) {
  return (
    <LayoutDiagramStage aria-hidden inert>
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
                <LayoutDiagramCell key={column}>
                  <LayoutDiagramLine />
                </LayoutDiagramCell>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <>
          <LayoutDiagramColumn>
            <DiagramPane />
            <DiagramPane tabs={["Terminal"]} />
          </LayoutDiagramColumn>
          <DiagramPane tabs={["Diff"]} />
        </>
      )}
      {lesson === "split" ? <LayoutDiagramSwap /> : null}
    </LayoutDiagramStage>
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
