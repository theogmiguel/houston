export const DIFF_EMPTY_CLASS =
  'h-full min-h-[90px] flex flex-col items-center justify-center gap-2 p-5 ' +
  'text-text-muted text-[length:var(--tr-text-sm)] text-center'

// `@keyframes git-spin` lives in tailwind.css, not here — grepping this file
// for it will not find it.
export const SPIN_CLASS = 'loop-anim motion-safe:animate-[git-spin_0.9s_linear_infinite]'

const CODE_CLASS = 'block min-w-full w-max pt-1 px-0 pb-2 font-mono text-[length:var(--tr-text-xs)] leading-[1.55]'

const PLAIN_CLASS =
  'm-0 pt-2 pr-3 pb-3 pl-[18px] text-text-secondary font-mono text-[length:var(--tr-text-xs)] ' +
  'leading-[1.55] whitespace-pre'

const LINE_BASE = 'flex items-start pr-3 whitespace-pre'

const LINE_KIND_CLASS: Record<string, string> = {
  ctx: 'text-text-secondary',
  add:
    'text-[color-mix(in_srgb,var(--success)_92%,var(--text-primary))] ' +
    'bg-[color-mix(in_srgb,var(--success)_12%,transparent)]',
  del:
    'text-[color-mix(in_srgb,var(--danger)_92%,var(--text-primary))] ' +
    'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]',
  hunk:
    'text-[color-mix(in_srgb,var(--info)_90%,var(--text-primary))] ' +
    'bg-[color-mix(in_srgb,var(--info)_8%,transparent)] font-semibold',
  meta: 'text-text-muted'
}

const GUTTER_CLASS =
  'shrink-0 w-[18px] pl-1.5 text-center ' +
  'text-[color-mix(in_srgb,currentColor_55%,transparent)] select-none'

const TEXT_CLASS = 'flex-1 min-w-0'

export function lineKind(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ') ||
    line.startsWith('\\ No newline')
  )
    return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

export function DiffBody({ patch, truncated }: { patch: string; truncated: boolean }): React.JSX.Element {
  const lines = patch.split('\n')
  // Above this, one <div> per line makes the DOM too heavy; fall back to a plain <pre>.
  if (lines.length > 4000)
    return (
      <pre className={PLAIN_CLASS}>
        {patch}
        {truncated ? '\n… patch truncated at 512 KiB — review locally' : ''}
      </pre>
    )
  return (
    <div className={CODE_CLASS} role="presentation">
      {lines.map((line, i) => {
        const kind = lineKind(line)
        return (
          <div key={i} className={`${LINE_BASE} ${LINE_KIND_CLASS[kind]}`} data-kind={kind}>
            <span className={GUTTER_CLASS} aria-hidden>
              {kind === 'add' ? '+' : kind === 'del' ? '−' : ''}
            </span>
            <span className={TEXT_CLASS}>{line || ' '}</span>
          </div>
        )
      })}
      {truncated && (
        <div className={`${LINE_BASE} ${LINE_KIND_CLASS.meta}`} data-kind="meta">
          <span className={GUTTER_CLASS} aria-hidden />
          <span className={TEXT_CLASS}>… patch truncated at 512 KiB — review locally</span>
        </div>
      )}
    </div>
  )
}
