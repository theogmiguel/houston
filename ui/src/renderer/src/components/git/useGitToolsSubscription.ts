import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'
import type { GitCheckpointInfo } from '../../houston/generated/GitCheckpointInfo'
import type { GitWorktreeInfo } from '../../houston/generated/GitWorktreeInfo'
import { defaultCheckpointLabel } from './checkpoints'
import type { WorktreeCleanupView } from './worktreeCleanup'
import { parseControlAdmission } from '../../houston/controlAdmission'
import { unansweredWorktreeCheck, WORKTREE_CHECK_TIMEOUT_MS, type WorktreeCheckView } from './worktrees'
import type { CheckpointInspect } from './CheckpointsDialog'

export type GitToolKind = 'branches' | 'worktrees' | 'checkpoints'

export interface GitToolsParams {
  client: HoustonClient | null
  repoDir: string | null
  /** Set while a tools mutation is in flight; the error router claims the next error for it. */
  pendingTools: RefObject<string | null>
  toolsError: string | null
  setToolsNotice: (text: string | null) => void
  setToolsBusy: (busy: boolean) => void
  setToolsError: (message: string | null) => void
}

export interface GitTools {
  branches: GitBranchInfo[]
  remotes: GitBranchInfo[]
  branchesTruncated: boolean
  defaultBranch: string | null
  worktrees: GitWorktreeInfo[]
  cleanup: WorktreeCleanupView
  removeCheck: WorktreeCheckView | null
  checkpoints: GitCheckpointInfo[]
  inspecting: CheckpointInspect | null
  ensure: (kind: GitToolKind) => void
  refreshBranches: () => void
  refreshWorktrees: () => void
  refreshCheckpoints: () => void
  pull: () => void
  fetch: () => void
  createBranch: (name: string, base: string | null, switchTo: boolean) => void
  switchBranch: (name: string) => void
  renameBranch: (from: string, to: string) => void
  deleteBranch: (name: string, force: boolean) => void
  createWorktree: (name: string, base: string | null) => void
  checkWorktree: (path: string) => void
  removeWorktree: (path: string, force: boolean) => void
  pruneWorktrees: () => void
  checkCleanup: () => void
  cleanNow: (paths: string[]) => void
  removeStale: (path: string) => void
  createCheckpoint: (label: string | null) => void
  inspectCheckpoint: (ref: string) => void
  restoreCheckpoint: (ref: string) => void
  deleteCheckpoint: (ref: string) => void
}

function stopTimer(timer: RefObject<ReturnType<typeof setTimeout> | null>): void {
  if (timer.current !== null) clearTimeout(timer.current)
  timer.current = null
}

// Owns every Git tool's data and every call that mutates it. The pane keeps
// the error router (ServerMsg::Error is connection-wide); this hook exposes the
// state that router feeds. Nothing is fetched until a dialog asks for it.
export function useGitToolsSubscription({
  client,
  repoDir,
  pendingTools,
  toolsError,
  setToolsNotice,
  setToolsBusy,
  setToolsError
}: GitToolsParams): GitTools {
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [remotes, setRemotes] = useState<GitBranchInfo[]>([])
  const [branchesTruncated, setBranchesTruncated] = useState(false)
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([])
  const [cleanup, setCleanup] = useState<WorktreeCleanupView>({ status: 'pending' })
  const [removeCheck, setRemoveCheck] = useState<WorktreeCheckView | null>(null)
  const [checkpoints, setCheckpoints] = useState<GitCheckpointInfo[]>([])
  const [inspecting, setInspecting] = useState<CheckpointInspect | null>(null)

  const asked = useRef<Set<GitToolKind>>(new Set())
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const begin = useCallback(
    (dir: string): void => {
      pendingTools.current = dir
      setToolsBusy(true)
      setToolsError(null)
      setToolsNotice(null)
    },
    [pendingTools, setToolsBusy, setToolsError, setToolsNotice]
  )

  useEffect(() => {
    if (!client || !repoDir) return
    const unsubBranches = client.subscribe('git_branches', (msg) => {
      if (msg.dir !== repoDir) return
      pendingTools.current = null
      setToolsBusy(false)
      setToolsError(null)
      setBranches(msg.branches)
      setRemotes(msg.remotes)
      setBranchesTruncated(msg.truncated)
      setDefaultBranch(msg.default_branch ?? null)
    })
    const unsubWorktrees = client.subscribe('git_worktrees', (msg) => {
      if (msg.dir !== repoDir) return
      pendingTools.current = null
      setToolsBusy(false)
      setToolsError(null)
      setWorktrees(msg.worktrees)
      if (msg.message) setToolsNotice(msg.message)
    })
    // Broadcast after every daemon pass as well as in reply, so an open dialog
    // follows the automatic cleanup without asking.
    const unsubCleanup = client.subscribe('worktree_cleanup', (msg) => {
      if (msg.dir !== repoDir) return
      if (pendingTools.current === repoDir) {
        pendingTools.current = null
        setToolsBusy(false)
      }
      setCleanup({ status: 'ready', entries: msg.entries })
    })
    // The check keeps its own pending state, apart from the tools' busy flag, so a lost
    // reply cannot disable Remove, Refresh and Prune.
    const unsubCheck = client.subscribe('worktree_check', (msg) => {
      if (msg.dir !== repoDir) return
      setRemoveCheck((c) => {
        if (c?.path !== msg.path) return c
        stopTimer(checkTimer)
        return { path: msg.path, status: 'ready', check: msg.check }
      })
    })
    const unsubCheckRefused = client.subscribe('error', (msg) => {
      const refusal = parseControlAdmission(msg.context)
      if (refusal?.kind !== 'worktree_check' || refusal.target !== repoDir) return
      setRemoveCheck((c) => {
        if (c?.status !== 'pending') return c
        stopTimer(checkTimer)
        return unansweredWorktreeCheck(c.path, msg.message)
      })
    })
    const unsubCheckpoints = client.subscribe('git_checkpoints', (msg) => {
      if (msg.dir !== repoDir) return
      pendingTools.current = null
      setToolsBusy(false)
      setToolsError(null)
      setCheckpoints(msg.checkpoints)
    })
    const unsubDiff = client.subscribe('git_checkpoint_diff', (msg) => {
      if (msg.dir !== repoDir) return
      pendingTools.current = null
      setToolsBusy(false)
      setToolsError(null)
      setInspecting({
        ref: msg.ref,
        patch: msg.patch,
        truncated: msg.truncated,
        redacted: msg.redacted,
        loading: false
      })
    })
    const unsubPull = client.subscribe('git_pull', (msg) => {
      if (msg.dir !== repoDir) return
      pendingTools.current = null
      setToolsBusy(false)
      setToolsError(null)
      setToolsNotice(msg.status === 'up_to_date' ? 'Already up to date.' : 'Pulled.')
    })
    const unsubFetch = client.subscribe('git_fetch', (msg) => {
      if (msg.dir !== repoDir) return
      pendingTools.current = null
      setToolsBusy(false)
      setToolsError(null)
      setToolsNotice(msg.summary)
    })
    return () => {
      unsubBranches()
      unsubWorktrees()
      unsubCleanup()
      unsubCheck()
      unsubCheckRefused()
      unsubCheckpoints()
      unsubDiff()
      unsubPull()
      unsubFetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and setters are stable identities
  }, [client, repoDir])

  // A failed inspect must stop showing its spinner; the error banner owns the
  // explanation, and the diff area goes back to empty.
  useEffect(() => {
    if (toolsError !== null) setInspecting(null)
  }, [toolsError])

  // A refused cleanup arrives as the connection-wide error the pane routes here.
  useEffect(() => {
    if (toolsError !== null) {
      setCleanup((c) => (c.status === 'pending' ? { status: 'refused', message: toolsError } : c))
    }
  }, [toolsError])

  useEffect(() => () => stopTimer(checkTimer), [])

  useEffect(() => {
    asked.current.clear()
    setBranches([])
    setRemotes([])
    setWorktrees([])
    setCleanup({ status: 'pending' })
    stopTimer(checkTimer)
    setRemoveCheck(null)
    setCheckpoints([])
    setInspecting(null)
  }, [repoDir])

  const ensure = useCallback(
    (kind: GitToolKind): void => {
      if (!client || !repoDir || asked.current.has(kind)) return
      asked.current.add(kind)
      if (kind === 'branches') client.gitBranches(repoDir)
      else if (kind === 'worktrees') {
        client.gitWorktrees(repoDir)
        client.worktreeCleanupStatus(repoDir)
      }
      else client.gitCheckpoints(repoDir)
    },
    [client, repoDir]
  )

  const refreshBranches = useCallback((): void => {
    if (!client || !repoDir) return
    asked.current.add('branches')
    begin(repoDir)
    client.gitBranches(repoDir)
  }, [client, repoDir, begin])

  const refreshWorktrees = useCallback((): void => {
    if (!client || !repoDir) return
    asked.current.add('worktrees')
    begin(repoDir)
    client.gitWorktrees(repoDir)
    setCleanup({ status: 'pending' })
    client.worktreeCleanupStatus(repoDir)
  }, [client, repoDir, begin])

  const refreshCheckpoints = useCallback((): void => {
    if (!client || !repoDir) return
    asked.current.add('checkpoints')
    begin(repoDir)
    client.gitCheckpoints(repoDir)
  }, [client, repoDir, begin])

  const withDir = useCallback(
    (fn: (dir: string) => void): void => {
      if (!client || !repoDir) return
      begin(repoDir)
      fn(repoDir)
    },
    [client, repoDir, begin]
  )

  return {
    branches,
    remotes,
    branchesTruncated,
    defaultBranch,
    worktrees,
    cleanup,
    removeCheck,
    checkpoints,
    inspecting,
    ensure,
    refreshBranches,
    refreshWorktrees,
    refreshCheckpoints,
    pull: () => withDir((dir) => client?.gitPull(dir)),
    fetch: () => withDir((dir) => client?.gitFetch(dir)),
    createBranch: (name, base, switchTo) =>
      withDir((dir) => client?.gitBranchCreate(dir, name, base, switchTo)),
    switchBranch: (name) => withDir((dir) => client?.gitBranchSwitch(dir, name)),
    renameBranch: (from, to) => withDir((dir) => client?.gitBranchRename(dir, from, to)),
    deleteBranch: (name, force) => withDir((dir) => client?.gitBranchDelete(dir, name, force)),
    createWorktree: (name, base) => withDir((dir) => client?.gitWorktreeCreate(dir, name, base)),
    checkWorktree: (path) => {
      if (!client || !repoDir) return
      stopTimer(checkTimer)
      setRemoveCheck({ path, status: 'pending' })
      client.worktreeCheck(repoDir, path)
      checkTimer.current = setTimeout(() => {
        checkTimer.current = null
        const reason = `no answer from the daemon within ${WORKTREE_CHECK_TIMEOUT_MS / 1000} s`
        setRemoveCheck((c) => (c?.path === path && c.status === 'pending' ? unansweredWorktreeCheck(path, reason) : c))
      }, WORKTREE_CHECK_TIMEOUT_MS)
    },
    removeWorktree: (path, force) => withDir((dir) => client?.gitWorktreeRemove(dir, path, force)),
    pruneWorktrees: () => withDir((dir) => client?.gitWorktreePrune(dir)),
    checkCleanup: () =>
      withDir((dir) => {
        setCleanup({ status: 'pending' })
        client?.worktreeCleanupRun(dir, [])
      }),
    cleanNow: (paths) =>
      withDir((dir) => {
        setCleanup({ status: 'pending' })
        client?.worktreeCleanupRun(dir, paths)
      }),
    removeStale: (path) =>
      withDir((dir) => {
        setCleanup({ status: 'pending' })
        client?.worktreeIdleRemove(dir, path)
      }),
    createCheckpoint: (label) =>
      withDir((dir) =>
        client?.gitCheckpointCreate(dir, label ?? defaultCheckpointLabel(Date.now()))
      ),
    inspectCheckpoint: (ref) => {
      if (!repoDir || !client) return
      pendingTools.current = repoDir
      client.gitCheckpointDiff(repoDir, ref, 'working')
      setInspecting({ ref, patch: '', truncated: false, redacted: false, loading: true })
    },
    restoreCheckpoint: (ref) => {
      setInspecting(null)
      withDir((dir) => client?.gitCheckpointRestore(dir, ref))
    },
    deleteCheckpoint: (ref) => withDir((dir) => client?.gitCheckpointDelete(dir, ref))
  }
}
