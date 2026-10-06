import type { ReactNode } from 'react'
/** The placeholder painted over the terminal until the first screen syncs. */
export function TerminalSkeleton({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 z-[calc(var(--z-pane)+1)] flex flex-col justify-center gap-[var(--space-terminal-skeleton-gap)] pt-[var(--space-1-5)] pr-[var(--space-1-5)] pb-[var(--space-1)] pl-[var(--space-3)] bg-[var(--terminal-skeleton-bg)] pointer-events-none"
      aria-hidden="true"
    >
      {children}
    </div>
  )
}

export function SkeletonCursor({ synced }: { synced: boolean }): React.JSX.Element {
  return (
    <div className="w-[var(--sz-terminal-skeleton-cursor)] pb-[var(--space-terminal-skeleton-cursor-gap)]">
      <div
        className={`loop-anim h-[var(--h-terminal-skeleton-cursor)] bg-[var(--text-primary)] motion-safe:[animation:skeleton-cursor-blink_1s_steps(2,end)_infinite] ${
          synced ? 'transition-opacity duration-[var(--animate-t-fast)] ease-linear opacity-0' : 'motion-reduce:opacity-70'
        }`}
      />
    </div>
  )
}

export function SkeletonLine({
  synced,
  widthPercent,
  delayMs,
}: {
  synced: boolean
  widthPercent: number
  delayMs: number
}): React.JSX.Element {
  return (
    <div
      className={`loop-anim h-[var(--h-terminal-skeleton-line)] rounded-[var(--tr-radius-terminal-skeleton-line)] bg-[color-mix(in_srgb,var(--text-faint)_20%,transparent)] transition-opacity duration-[var(--animate-t-fast)] ease-linear motion-safe:[animation:skeleton-shimmer_1.4s_steps(4,end)_infinite] ${
        synced ? 'opacity-0' : 'opacity-100 motion-reduce:opacity-70'
      }`}
      style={{ width: `${widthPercent}%`, transitionDelay: `${delayMs}ms` }}
    />
  )
}
