import { cn } from "~/lib/utils";

export function PreviewAddressLabel({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: "neutral" | "warning";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "mr-1.5 shrink-0 rounded-sm px-1 py-0.5 text-3xs font-medium uppercase tracking-wide",
        tone === "warning"
          ? "bg-warning-surface text-warning-foreground"
          : "bg-(--field) text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}
