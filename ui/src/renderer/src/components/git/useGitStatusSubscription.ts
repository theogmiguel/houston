import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { GitFileStatus, HoustonClient } from '../../houston/client'

export interface DiffState {
  path: string
  patch: string
  truncated: boolean
}

export interface GitStatusSubscriptionParams {
  client: HoustonClient | null
  repoDir: string | null
  base: string | null
  pendingStatus: RefObject<string | null>
  pendingCommit: RefObject<string | null>
  pendingPush: RefObject<string | null>
  pushAfterCommitRef: RefObject<boolean>
  setFiles: Dispatch<SetStateAction<GitFileStatus[] | null>>
  setDiff: Dispatch<SetStateAction<DiffState | null>>
  setSelected: Dispatch<SetStateAction<string | null>>
  setBranch: Dispatch<SetStateAction<string | null>>
  setAhead: Dispatch<SetStateAction<number>>
  setBehind: Dispatch<SetStateAction<number>>
  setUpstream: Dispatch<SetStateAction<string | null>>
  setDefaultBase: Dispatch<SetStateAction<string | null>>
  setStatusError: Dispatch<SetStateAction<string | null>>
  setCommitError: Dispatch<SetStateAction<string | null>>
  setCommitting: Dispatch<SetStateAction<boolean>>
  setPushing: Dispatch<SetStateAction<boolean>>
  setPushAfterCommit: Dispatch<SetStateAction<boolean>>
  setCommitMsg: Dispatch<SetStateAction<string>>
}

export function useGitStatusSubscription({
  client,
  repoDir,
  base,
  pendingStatus,
  pendingCommit,
  pendingPush,
  pushAfterCommitRef,
  setFiles,
  setDiff,
  setSelected,
  setBranch,
  setAhead,
  setBehind,
  setUpstream,
  setDefaultBase,
  setStatusError,
  setCommitError,
  setCommitting,
  setPushing,
  setPushAfterCommit,
  setCommitMsg
}: GitStatusSubscriptionParams): void {
  useEffect(() => {
    setFiles(null)
    setDiff(null)
    setSelected(null)
    setStatusError(null)
    setCommitError(null)
    if (!client || !repoDir) return
    const unsubStatus = client.subscribe('git_status', (msg) => {
      if (msg.dir !== repoDir) return
      if ((msg.base ?? null) !== base) return
      pendingStatus.current = null
      setStatusError(null)
      setFiles(msg.files)
      setBranch(msg.branch)
      setAhead(msg.ahead)
      setBehind(msg.behind)
      setUpstream(msg.upstream ?? null)
      setDefaultBase(msg.default_base ?? null)
      setPushAfterCommit(false)
      // `git_push` has no reply of its own — a fresh `git_status` broadcast IS
      // the push's receipt, which is why pendingPush clears here.
      pendingPush.current = null
      setPushing(false)
    })
    const unsubDiff = client.subscribe('git_diff', (msg) => {
      if (msg.dir !== repoDir) return
      if ((msg.base ?? null) !== base) return
      setDiff({ path: msg.path ?? '', patch: msg.patch, truncated: msg.truncated })
    })
    const unsubCommit = client.subscribe('git_commit', (msg) => {
      if (msg.dir !== repoDir) return
      pendingCommit.current = null
      setCommitting(false)
      setCommitError(null)
      setCommitMsg('')
      if (pushAfterCommitRef.current) {
        pushAfterCommitRef.current = false
        pendingPush.current = repoDir
        setPushing(true)
        client.gitPush(repoDir)
      }
    })
    pendingStatus.current = repoDir
    client.gitStatus(repoDir, base)
    return () => {
      unsubStatus()
      unsubDiff()
      unsubCommit()
      pendingStatus.current = null
      pendingCommit.current = null
      pendingPush.current = null
      setCommitting(false)
      setPushing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and setters are stable identities, not real deps; mirrors the original effect's own [client, repoDir, base].
  }, [client, repoDir, base])
}
