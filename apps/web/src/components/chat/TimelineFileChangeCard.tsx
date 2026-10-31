import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { ExternalLinkIcon, FileIcon } from "lucide-react";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { cn } from "~/lib/utils";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

interface DiffRow {
  readonly kind: "context" | "add" | "del" | "hunk";
  readonly number: number | null;
  readonly text: string;
}

function parseDiff(item: FileChangeItem): DiffRow[] {
  const raw = item.diffStr;
  if (raw?.trim()) {
    const rows: DiffRow[] = [];
    let oldLine = 0;
    let newLine = 0;
    for (const line of raw.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
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

/** One file's change, drawn as the Timeline board's inline diff card. */
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
  return (
    <section
      aria-label={`Diff for ${item.fileName}`}
      className="overflow-hidden rounded-(--r-group) border border-border bg-card"
    >
      <div className="flex h-9 items-center gap-2 border-b border-border pe-1.5 ps-3">
        <FileIcon aria-hidden className="size-3.5 shrink-0 text-(--t3)" />
        <span className="min-w-0 flex-1 truncate font-mono text-mono text-(--t1)">
          {formatWorkspaceRelativePath(item.fileName, workspaceRoot)}
        </span>
        <span className="shrink-0 text-callout text-(--t3) tabular-nums">
          {additions > 0 ? <span className="text-(--ok-ink)">+{additions}</span> : null}
          {additions > 0 && deletions > 0 ? " " : null}
          {deletions > 0 ? <span className="text-(--stop-ink)">−{deletions}</span> : null}
        </span>
        {onOpenDiff ? (
          <button
            type="button"
            aria-label="Open diff"
            onClick={onOpenDiff}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-(--r-ctl) text-(--t3) transition-colors hover:bg-(--hover) hover:text-(--t1) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <div className="max-h-96 overflow-auto bg-(--code-bg) py-1.5 font-mono text-mono leading-5">
          {rows.map((row) => (
            <div
              key={`${row.kind}:${row.number ?? row.text}`}
              className={cn(
                "grid grid-cols-[36px_14px_minmax(0,1fr)]",
                row.kind === "add" && "bg-(--add-bg)",
                row.kind === "del" && "bg-(--del-bg)",
                row.kind === "hunk" && "text-(--t3)",
              )}
            >
              <span className="select-none pe-2 text-right text-(--t3) tabular-nums">
                {row.number ?? ""}
              </span>
              <span
                aria-hidden
                className={cn(
                  row.kind === "add" && "text-(--ok-ink)",
                  row.kind === "del" && "text-(--stop-ink)",
                  row.kind === "context" && "text-(--t3)",
                  row.kind === "hunk" && "text-(--t3)",
                )}
              >
                {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
              </span>
              <span className="whitespace-pre-wrap wrap-anywhere">{row.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
