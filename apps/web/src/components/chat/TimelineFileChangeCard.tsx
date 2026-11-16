import type { OrchestrationV2TurnItem } from "@houston-app/contracts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { cn } from "~/lib/utils";
import { TIMELINE_CHANGE_DIFF_CLS } from "../ui/timeline-changes-recipes";
import { TimelineChangesRow } from "./TimelineChangesRow";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

interface DiffRow {
  readonly kind: "context" | "add" | "del" | "hunk";
  readonly number: number | null;
  readonly text: string;
}

const HUNK_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseDiff(item: FileChangeItem): DiffRow[] {
  const raw = item.diffStr;
  if (raw?.trim()) {
    const rows: DiffRow[] = [];
    let oldLine = 0;
    let newLine = 0;
    for (const line of raw.split("\n")) {
      const hunk = HUNK_PATTERN.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        rows.push({ kind: "hunk", number: null, text: line });
        continue;
      }
      if (
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("\\ No newline")
      ) {
        continue;
      }
      if (line.startsWith("+")) {
        rows.push({ kind: "add", number: newLine, text: line.slice(1) });
        newLine += 1;
      } else if (line.startsWith("-")) {
        rows.push({ kind: "del", number: oldLine, text: line.slice(1) });
        oldLine += 1;
      } else {
        rows.push({ kind: "context", number: newLine, text: line.slice(1) });
        oldLine += 1;
        newLine += 1;
      }
    }
    return rows;
  }
  if (item.oldStr !== undefined || item.newStr !== undefined) {
    return [
      ...(item.oldStr ?? "").split("\n").map((text, index): DiffRow => ({
        kind: "del",
        number: index + 1,
        text,
      })),
      ...(item.newStr ?? "").split("\n").map((text, index): DiffRow => ({
        kind: "add",
        number: index + 1,
        text,
      })),
    ];
  }
  return [];
}

/** One file's change, drawn as the timeline's shared change row with its inline diff. */
export function TimelineFileChangeCard({
  item,
  workspaceRoot,
  onOpenDiff,
}: {
  item: FileChangeItem;
  workspaceRoot: string | undefined;
  onOpenDiff?: (() => void) | undefined;
}) {
  const rows = parseDiff(item);
  const additions = item.additions ?? rows.filter((row) => row.kind === "add").length;
  const deletions = item.deletions ?? rows.filter((row) => row.kind === "del").length;
  const path = formatWorkspaceRelativePath(item.fileName, workspaceRoot);
  return (
    <section aria-label={`Diff for ${path}`}>
      <TimelineChangesRow
        files={[{ path: item.fileName, additions, deletions }]}
        totals={{ count: 1, additions, deletions }}
        workspaceRoot={workspaceRoot}
        {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
        onOpenFile={() => onOpenDiff?.()}
        detail={
          rows.length > 0 ? (
            <div className={TIMELINE_CHANGE_DIFF_CLS}>
              {rows.map((row) => (
                <div
                  key={`${row.kind}:${row.number ?? row.text}`}
                  className={cn(
                    "grid grid-cols-[36px_14px_minmax(0,1fr)]",
                    row.kind === "add" && "bg-(--add-bg)",
                    row.kind === "del" && "bg-(--del-bg)",
                    row.kind === "hunk" && "text-(--houston)",
                  )}
                >
                  <span className="select-none pe-2 text-right text-(--houston) tabular-nums">
                    {row.number ?? ""}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      row.kind === "add" && "text-(--ok-ink)",
                      row.kind === "del" && "text-(--stop-ink)",
                      row.kind === "context" && "text-(--houston)",
                      row.kind === "hunk" && "text-(--houston)",
                    )}
                  >
                    {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
                  </span>
                  <span className="whitespace-pre-wrap wrap-anywhere">{row.text}</span>
                </div>
              ))}
            </div>
          ) : undefined
        }
      />
    </section>
  );
}
