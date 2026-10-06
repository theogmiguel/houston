import { useEffect, useState } from 'react'
import type { GitBranchCommit, HoustonClient } from '../../houston/client'
import { useAgeNow, relativeAge } from '../ageTicker'

interface BranchCommitsProps {
  client: HoustonClient | null
  dir: string
}

export function BranchCommits({ client, dir }: BranchCommitsProps): React.JSX.Element | null {
  const [commits, setCommits] = useState<GitBranchCommit[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const tickingNow = useAgeNow(commits.length > 0)
  useEffect(() => {
    if (!client || !dir || typeof client.gitBranchCommits !== 'function') return
    let pending = true
    const load = (): void => {
      pending = true
      setError(null)
      client.gitBranchCommits(dir)
    }
    const offCommits = client.subscribe('git_branch_commits', (message) => {
      if (message.dir !== dir) return
      pending = false
      setCommits(message.commits)
      setTotal(message.total)
      setError(null)
    })
    const offError = client.subscribe('error', (message) => {
      if (!pending) return
      pending = false
      if (/no upstream|expected the current branch to have an upstream/i.test(message.message)) {
        setCommits([])
        setTotal(0)
        setError(null)
      } else {
        setError(message.message.replace(/\s+/g, ' ').trim())
      }
    })
    const offStatus = client.subscribe('git_status', (message) => {
      if (message.dir === dir && message.base === null) load()
    })
    const offCommit = client.subscribe('git_commit', (message) => {
      if (message.dir === dir) load()
    })
    load()
    return () => {
      pending = false
      offCommits()
      offError()
      offStatus()
      offCommit()
    }
  }, [client, dir])

  if (total === 0 && error === null) return null
  const visibleCommits = expanded ? commits : commits.slice(0, 2)

  return (
    <section data-testid="branch-commits">
      <div data-branch-commits-head>
        <span>On this branch · {total} commits</span>
        {commits.length > 2 && (
          <button type="button" data-branch-commits-toggle onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Show less' : 'View all'}
          </button>
        )}
      </div>
      {error ? (
        <p data-testid="branch-commits-error">{error}</p>
      ) : visibleCommits.map((commit) => (
        <div key={commit.sha} data-testid="branch-commit-row">
          <span data-branch-commit-sha>{commit.sha}</span>
          <span data-branch-commit-subject>{commit.subject}</span>
          <span data-branch-commit-age>{relativeAge(commit.author_time_ms, tickingNow)}</span>
        </div>
      ))}
    </section>
  )
}
