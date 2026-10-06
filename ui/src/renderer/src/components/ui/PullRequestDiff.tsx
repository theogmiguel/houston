import type { HTMLAttributes, ReactNode } from 'react'

export function DiffFileSection({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`flex flex-col border-t border-t-[var(--divider)] first:border-t-0 ${props.className ?? ''}`}>{children}</div>
}

export function DiffFileHeading({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`sticky top-0 z-[var(--z-sticky)] flex items-center gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-1-5)] bg-[var(--card-bg)] border-b border-b-[var(--divider)] ${props.className ?? ''}`}>{children}</div>
}

export function DiffCodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col font-mono text-[length:var(--tr-text-xs)] leading-[var(--tr-diff-line-leading)]">{children}</div>
}

export function DiffHunk({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col">{children}</div>
}

export function DiffCommentComposer({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`flex flex-col gap-[var(--space-1-5)] px-[var(--space-2)] py-[var(--space-2)] bg-[var(--material-shell-bg)] ${props.className ?? ''}`}>{children}</div>
}

export function DiffCommentActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]">{children}</div>
}

export function DiffLoadingPanel({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`flex-1 flex items-center justify-center p-[var(--space-6)] ${props.className ?? ''}`}>{children}</div>
}

export function PullRequestDiffPanel({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`flex flex-col bg-[var(--tool-code-bg)] ${props.className ?? ''}`}>{children}</div>
}

export function PullRequestDiffSpecimen(): React.JSX.Element {
  return <PullRequestDiffPanel><DiffFileSection><DiffFileHeading><span>src/parser.ts</span><span>+2 −1</span></DiffFileHeading><DiffCodeBlock><DiffHunk><div>@@ -1 +1 @@</div><div>+ const value = 1</div></DiffHunk></DiffCodeBlock><DiffCommentComposer><textarea rows={2} /><DiffCommentActions><button>Add to review</button><button>Cancel</button></DiffCommentActions></DiffCommentComposer></DiffFileSection></PullRequestDiffPanel>
}
