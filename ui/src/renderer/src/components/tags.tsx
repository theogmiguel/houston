import type { TagInfo } from "../houston/generated/TagInfo";
import { Tooltip } from "./Tooltip";

export function TagChip({
  tag,
  onToggle,
  tooltip,
  compact = false,
}: {
  tag: TagInfo;
  onToggle?: () => void;
  tooltip?: string;
  compact?: boolean;
}): React.JSX.Element {
  const cls = compact
    ? "inline-flex items-center justify-center flex-none w-[var(--h-tag-chip)] h-[var(--h-tag-chip)] rounded-[var(--tr-radius-sm)]"
    : "inline-flex items-center gap-[5px] flex-none max-w-[var(--tag-chip-max,56px)] h-[var(--h-tag-chip)] px-[5px] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] leading-none whitespace-nowrap";
  const style = compact
    ? { ["--tag" as string]: tag.color }
    : {
        ["--tag" as string]: tag.color,
        background: "color-mix(in srgb, var(--tag) 13%, transparent)",
        color: "color-mix(in srgb, var(--tag) 72%, #fff)",
        border: "1px solid color-mix(in srgb, var(--tag) 26%, transparent)",
      };
  const inner = compact ? (
    <TagDot compact />
  ) : (
    <>
      <TagDot />
      <span className="truncate">{tag.name}</span>
    </>
  );
  if (!onToggle) {
    const chip = (
      <span className={cls} style={style} data-testid="tag-chip">
        {inner}
      </span>
    );
    return tooltip ? <Tooltip label={tooltip}>{chip}</Tooltip> : chip;
  }
  return (
    <Tooltip label={tooltip ?? tag.name}>
      <button
        type="button"
        aria-label={`Filter by ${tag.name}`}
        data-testid="tag-chip"
        className={`${cls} cursor-default hover:brightness-110`}
        style={style}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {inner}
      </button>
    </Tooltip>
  );
}

function TagDot({ compact = false }: { compact?: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={`${compact ? "w-[6px] h-[6px]" : "w-[5px] h-[5px]"} rounded-full flex-none`}
      style={{ background: "var(--tag)" }}
    />
  );
}

const TAG_MORE_CLS =
  "inline-flex items-center justify-center flex-none h-[var(--h-tag-chip)] min-w-[var(--h-tag-chip)] px-[5px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-hover)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] leading-none text-[var(--text-muted)] tabular-nums";

export function TagChipRow({
  tags,
  onToggle,
  compact = false,
}: {
  tags: TagInfo[];
  onToggle: (tag: TagInfo) => void;
  compact?: boolean;
}): React.JSX.Element | null {
  if (tags.length === 0) return null;
  const [first, ...rest] = tags;
  return (
    <span
      data-testid="tag-chips"
      className="inline-flex items-center gap-[4px] flex-none"
    >
      <TagChip tag={first} onToggle={() => onToggle(first)} compact={compact} />
      {rest.length > 0 && (
        <Tooltip label={`Also ${rest.map((t) => t.name).join(", ")}`}>
          <span data-testid="tag-chips-more" className={TAG_MORE_CLS}>
            +{rest.length}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

