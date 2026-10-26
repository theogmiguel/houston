import { useEffect, useMemo, useRef } from 'react'
import { ChangesPane } from '../src/components/ChangesPane'
import type { HoustonClient } from '../src/houston/client'
import { InspectorClient } from './inspectorStories'

export function ChangesStory({ ready = false, compact = true, maximized = false, staged = true, branchComparison = false }: { ready?: boolean; compact?: boolean; maximized?: boolean; staged?: boolean; branchComparison?: boolean }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const client = useMemo(() => {
    localStorage.setItem('tr-scm-draft:/repo', ready ? 'fix(panes): repaint in the same frame after a resize' : '')
    return new InspectorClient(false, true, undefined, !staged)
  }, [ready, staged])
  useEffect(() => {
    if (!branchComparison || !host.current) return
    const observer = new MutationObserver(() => {
      const choice = host.current?.querySelector<HTMLButtonElement>('[data-testid="changes-scope-branch"]')
      if (!choice || choice.disabled) return
      observer.disconnect()
      choice.click()
    })
    observer.observe(host.current, { subtree: true, childList: true, attributes: true })
    return () => observer.disconnect()
  }, [branchComparison])
  return <div ref={host} className="flex h-full min-h-0" style={{ width: compact && !maximized ? 470 : '100%' }}>
    <ChangesPane client={client as unknown as HoustonClient} dir="/repo" compact={compact} maximized={maximized} checkoutPanes={[{ id: 3, path: "/repo/.houston/worktrees/pr-list" }]} onOpenPane={() => {}} checkoutLabel="inspector-polish" />
  </div>
}

const PAUSED_REBASE_STATUS = {
  type: 'git_status', branch: 'houston/fix-login', upstream: 'origin/houston/fix-login', ahead: 3, behind: 0,
  default_base: 'main', not_a_repo: false, operation: 'rebase',
  files: [
    { path: 'src/auth/session.ts', status: 'conflicted', staged: false, added: 14, deleted: 6, is_sensitive: false },
    { path: 'src/auth/login.tsx', status: 'conflicted', staged: false, added: 4, deleted: 2, is_sensitive: false },
    { path: 'README.md', status: 'modified', staged: true, added: 2, deleted: 0, is_sensitive: false }
  ]
}

// The inspector fixture, with the status of a rebase stopped on two conflicts.
export function ChangesPausedRebaseStory(): React.JSX.Element {
  const client = useMemo(() => {
    const inner = new InspectorClient(false, true)
    const status = new Set<(message: never) => void>()
    return new Proxy(inner, {
      get(target, prop) {
        if (prop === 'subscribe') {
          return (kind: string, handler: (message: never) => void) => {
            if (kind !== 'git_status') return target.subscribe(kind, handler)
            status.add(handler)
            return () => status.delete(handler)
          }
        }
        if (prop === 'gitStatus') {
          return (dir: string, base: string | null = null) => setTimeout(() => status.forEach((h) => h({ ...PAUSED_REBASE_STATUS, dir, base } as never)), 10)
        }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }, [])
  return <div className="flex h-full min-h-0" style={{ width: 470 }}>
    <ChangesPane client={client as unknown as HoustonClient} dir="/repo" compact checkoutLabel="fix-login" />
  </div>
}
