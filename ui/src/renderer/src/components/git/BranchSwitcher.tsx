import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HoustonClient } from '../../houston/client'
import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'
import type { GitTools } from './useGitToolsSubscription'
import { nameShapeLooksValid } from './branches'
import { branchSyncLabel, recentBranches, worktreeSlug } from './branchSwitcherModel'
import { BranchSwitcherList, BranchSwitcherFooter, BranchSwitcherGroup, BranchSwitcherRow, BranchSwitcherSearch, BranchSwitcherSurface, ChangesBranchChip } from '../ui/BranchSwitcher'
import { Button } from '../ui/Button'
import { Text } from '../ui/Text'

export interface CheckoutPane { id: number; path: string }

export function BranchSwitcher({ client, dir, branch, base, tools, busy, error, onManage, panes = [], onOpenPane }: {
  client: HoustonClient | null; dir: string; branch: string | null; base: string | null; tools: GitTools; busy: boolean; error: string | null; onManage: () => void; panes?: CheckoutPane[]; onOpenPane?: (id: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<number | null>(null)
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 380 })
  const trigger = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const pendingWorktree = useRef<{ name: string; known: Set<string> } | null>(null)
  const id = useId()
  const name = query.trim()
  const recent = useMemo(() => recentBranches(tools.branches), [tools.branches])
  const matching = recent.filter((item) => item.name.toLowerCase().includes(name.toLowerCase()))
  const shown = matching.length > 0 ? matching : recent
  const create = nameShapeLooksValid(name) && !tools.branches.some((item) => item.name === name) && !tools.remotes.some((item) => item.name === name)
  const slug = worktreeSlug(name)
  const worktreeBranch = `houston/${slug}`
  const worktreeTaken = tools.branches.some((item) => item.name === worktreeBranch)
  const count = shown.length + (create ? 2 : 0)
  const selected = active !== null && active < count ? active : create ? 0 : null
  const defaultBase = tools.defaultBranch ?? base
  const currentWorktree = tools.worktrees.some((item) => item.path === dir && !item.is_main)

  useEffect(() => {
    if (!client) return
    const off = client.subscribe('git_worktrees', (message) => {
      const pending = pendingWorktree.current
      if (message.dir !== dir || !pending) return
      const created = message.worktrees.find((item) => item.branch === pending.name && !pending.known.has(item.path))
      if (!created) return
      pendingWorktree.current = null
      client.createSession({ agent: 'shell', project_dir: created.path })
    })
    return () => { off(); pendingWorktree.current = null }
  }, [client, dir])

  useEffect(() => { if (error) pendingWorktree.current = null }, [error])

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const closeOutside = (event: MouseEvent): void => {
      if (!surface.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const close = (): void => setOpen(false)
    document.addEventListener('mousedown', closeOutside)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      trigger.current?.focus()
    }
  }, [open])

  const createBranch = (worktree: boolean): void => {
    if (!create || busy || !client) return
    if (worktree) {
      if (worktreeTaken) return
      pendingWorktree.current = { name: worktreeBranch, known: new Set(tools.worktrees.map((item) => item.path)) }
      tools.createWorktree(slug, defaultBase)
    } else tools.createBranch(name, defaultBase, true)
    setOpen(false)
  }
  const chooseBranch = (item: GitBranchInfo): void => {
    if (busy || item.current || !client) return
    if (item.worktree_path) {
      const pane = panes.find((pane) => pane.path === item.worktree_path)
      if (pane && onOpenPane) onOpenPane(pane.id)
      else client.createSession({ agent: 'shell', project_dir: item.worktree_path })
    } else tools.switchBranch(item.name)
    setOpen(false)
  }
  const choose = (index: number): void => {
    if (create && index < 2) createBranch(index === 1)
    else {
      const item = shown[index - (create ? 2 : 0)]
      if (item) chooseBranch(item)
    }
  }
  const branchNote = (item: GitBranchInfo): string | null => {
    if (item.current && currentWorktree) return 'worktree · this pane'
    if (item.worktree_path) {
      const pane = panes.find((pane) => pane.path === item.worktree_path)
      return pane ? `worktree · open in pane ${pane.id}` : 'worktree'
    }
    return branchSyncLabel(item) ?? (item.is_default ? 'default' : null)
  }
  return <>
    <ChangesBranchChip ref={trigger} data-testid="changes-branch-chip" aria-label={`Branch: ${branch ?? 'Detached HEAD'}`} aria-haspopup="dialog" aria-expanded={open} disabled={!client} branch={branch ?? 'Detached HEAD'} worktree={currentWorktree} onClick={() => {
      if (open) { setOpen(false); return }
      const rect = trigger.current!.getBoundingClientRect()
      const width = Math.min(380, window.innerWidth - 24)
      setAnchor({ top: Math.min(rect.bottom + 4, Math.max(0, window.innerHeight - 420)), left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width })
      setQuery('')
      setActive(null)
      tools.ensure('branches')
      tools.ensure('worktrees')
      setOpen(true)
    }} />
    {open && createPortal(<BranchSwitcherSurface ref={surface} role="dialog" aria-label="Switch or create a branch" style={anchor} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(count === 0 ? null : Math.max(0, Math.min(count - 1, (selected ?? (event.key === 'ArrowDown' ? -1 : count)) + (event.key === 'ArrowDown' ? 1 : -1))))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (event.ctrlKey || event.metaKey) createBranch(true)
        else if (selected !== null) choose(selected)
      }
    }}>
      <BranchSwitcherSearch inputRef={input} value={query} onChange={(event) => { setQuery(event.target.value); setActive(null) }} role="combobox" aria-label="Find or create a branch" placeholder="Find or create a branch" aria-expanded aria-controls={`${id}-options`} aria-activedescendant={selected === null ? undefined : `${id}-${selected}`} />
      <BranchSwitcherList role="listbox" id={`${id}-options`} aria-label="Branches">
        {create && <>
          <BranchSwitcherGroup>Create</BranchSwitcherGroup>
          <BranchSwitcherRow id={`${id}-0`} role="option" aria-selected={selected === 0} active={selected === 0} kind="create" shortcut="Enter" disabled={busy} onMouseMove={() => setActive(0)} onClick={() => createBranch(false)}>Branch <strong>{name}</strong> from {defaultBase ?? 'HEAD'}</BranchSwitcherRow>
          <BranchSwitcherRow id={`${id}-1`} role="option" aria-selected={selected === 1} active={selected === 1} kind="worktree" shortcut="Ctrl Enter" disabled={busy || worktreeTaken} onMouseMove={() => setActive(1)} onClick={() => createBranch(true)}>Worktree <strong>{worktreeBranch}</strong> in a new pane</BranchSwitcherRow>
        </>}
        <BranchSwitcherGroup>Branches</BranchSwitcherGroup>
        {shown.map((item, index) => {
          const position = index + (create ? 2 : 0)
          return <BranchSwitcherRow key={item.name} id={`${id}-${position}`} role="option" aria-selected={selected === position} active={selected === position} current={item.current} note={branchNote(item)} disabled={busy || item.current} onMouseMove={() => setActive(position)} onClick={() => chooseBranch(item)}>{item.name}</BranchSwitcherRow>
        })}
        {shown.length === 0 && <Text size="small" tone="muted">No branches found.</Text>}
        {name && !nameShapeLooksValid(name) && <Text size="small" tone="muted">Cannot create “{name}”: use a Git branch name without whitespace or a leading hyphen.</Text>}
        {create && worktreeTaken && <Text size="small" tone="muted">Worktree branch “{worktreeBranch}” already exists. Choose another name.</Text>}
        {tools.branchesTruncated && <Text size="small" tone="muted">Showing the first 200 branches.</Text>}
      </BranchSwitcherList>
      <BranchSwitcherFooter>
        <span>Switching keeps uncommitted changes or refuses with the files that block it.</span>
        <Button variant="link" size="sm" onClick={() => { setOpen(false); onManage() }}>Manage…</Button>
      </BranchSwitcherFooter>
    </BranchSwitcherSurface>, document.body)}
  </>
}
