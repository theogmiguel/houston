import React from 'react'
import { NoticeStack } from '../src/components/NoticeStack'
import { resolveNotice, type NoticeRecord, type NoticeStore } from '../src/notices'

const rec = (over: Partial<NoticeRecord> & { code: string; title: string }, id: number): NoticeRecord => ({
  ...resolveNotice(over, id),
  ...over,
  id
})

function store(notices: NoticeRecord[], evicted = 0): NoticeStore {
  return { notices, evicted, push: () => '', dismiss: () => {} }
}

function Ground({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 8,
        padding: 8,
        background: 'var(--content-bg)',
        boxSizing: 'border-box'
      }}
    >
      {[0, 1].map((i) => (
        <div
          key={i}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--tr-radius-md)',
            background: 'var(--pane-bg, var(--surface))'
          }}
        />
      ))}
      {children}
    </div>
  )
}

export function NoticesResting(): React.JSX.Element {
  return (
    <Ground>
      <NoticeStack
        anchor="workspace-top"
        label="Workspace notices"
        store={store([rec({ code: 'skill', title: 'Skill sent to the agent', kind: 'info' }, 1)])}
      />
    </Ground>
  )
}

export function NoticesStacked(): React.JSX.Element {
  return (
    <Ground>
      <NoticeStack
        anchor="workspace-top"
        label="Workspace notices"
        store={store([
          rec({ code: 'a', title: 'Detached the agent into its own workspace', kind: 'info' }, 1),
          rec(
            {
              code: 'b',
              title: 'Your latest pane layout could not be saved',
              kind: 'warning',
              action: { label: 'Retry save', onClick: () => {} }
            },
            2
          ),
          rec(
            {
              code: 'c',
              title: 'Could not resume claude in ~/code/houston',
              body: 'no such file or directory',
              kind: 'error'
            },
            3
          )
        ])}
      />
    </Ground>
  )
}

export function NoticesError(): React.JSX.Element {
  return (
    <Ground>
      <NoticeStack
        anchor="workspace-top"
        label="Workspace notices"
        store={store(
          [
            rec(
              {
                code: 'e',
                title: 'Cannot add another tab to this stack',
                body: 'stack is full (4/4)',
                kind: 'error'
              },
              1
            )
          ],
          2
        )}
      />
    </Ground>
  )
}

// The exit runs 120ms and the row unmounts 130ms after it starts, so waiting
// cannot photograph it. This stamps the real `notice-out-top` keyframe paused
// 60ms in, making the frame the animation's own rather than a mock of it.
export function NoticesExiting(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const rows = ref.current?.querySelectorAll<HTMLElement>('[data-notice]')
    const row = rows?.[1]
    if (!row) return
    row.style.animation = 'notice-out-top var(--motion-fast-t) var(--motion-fast-ease) forwards'
    row.style.animationPlayState = 'paused'
    row.style.animationDelay = '-60ms'
  }, [])
  return (
    <div ref={ref} style={{ height: '100%' }}>
      <Ground>
        <NoticeStack
          anchor="workspace-top"
          label="Workspace notices"
          store={store([
            rec({ code: 'a', title: 'Detached the agent into its own workspace', kind: 'info' }, 1),
            rec({ code: 'b', title: 'Copied 200 lines', kind: 'success' }, 2),
            rec({ code: 'c', title: 'Sign-in timed out', kind: 'warning' }, 3)
          ])}
        />
      </Ground>
    </div>
  )
}

export function NoticesPaneCorner(): React.JSX.Element {
  return (
    <Ground>
      <NoticeStack
        anchor="pane-corner"
        label="Pane notices"
        store={store([
          rec({ code: 'p1', title: 'Path pasted', body: '~/code/houston/ui', kind: 'success' }, 1),
          rec({ code: 'p2', title: 'Uploading…', body: 'screenshot.png', kind: 'info' }, 2)
        ])}
      />
    </Ground>
  )
}
