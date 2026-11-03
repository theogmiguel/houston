import { cn } from "~/lib/utils";

/** A thin completion bar; the filled share carries the brand accent. */
export function Progress({
  value,
  max,
  label,
  className,
}: {
  readonly value: number;
  readonly max: number;
  readonly label: string;
  readonly className?: string;
}) {
  const total = Math.max(0, max);
  const done = Math.min(Math.max(0, value), total);
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-[var(--field)]", className)}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
