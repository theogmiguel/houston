import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient } from '../../houston/client'

export interface GitWriter {
  generatingCommit: boolean
  generateCommit: () => void
  compose: {
    open: boolean
    title: string
    body: string
    generating: boolean
    creating: boolean
    error: string | null
  }
  openCompose: () => void
  generatePrContent: () => void
  createComposedPr: (title: string, body: string) => void
  cancelCompose: () => void
  composeFailed: (message: string) => void
}

export interface GitWriterParams {
  client: HoustonClient | null
  repoDir: string | null
  /** Whether the Create PR path is offered at all; generation rides on it. */
  offered: boolean
  pendingCompose: React.RefObject<string | null>
  onCommitMessage: (message: string | null) => void
  onCommitError: (message: string | null) => void
}

// The one-shot writer calls behind "write this with AI". A writer failure is a
// reply, not an error, and nothing mutates until the user accepts the text.
export function useGitWriter({
  client,
  repoDir,
  offered,
  pendingCompose,
  onCommitMessage,
  onCommitError
}: GitWriterParams): GitWriter {
  const [generatingCommit, setGeneratingCommit] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeTitle, setComposeTitle] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [composeGenerating, setComposeGenerating] = useState(false)
  const [composeCreating, setComposeCreating] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)

  const commitRef = useRef(onCommitMessage)
  useEffect(() => {
    commitRef.current = onCommitMessage
  }, [onCommitMessage])
  const errorRef = useRef(onCommitError)
  useEffect(() => {
    errorRef.current = onCommitError
  }, [onCommitError])

  useEffect(() => {
    if (!client || !repoDir) return
    const unsubCommit = client.subscribe('git_commit_message', (msg) => {
      if (msg.dir !== repoDir) return
      setGeneratingCommit(false)
      if (msg.message) {
        commitRef.current(msg.message)
        errorRef.current(null)
      }
      if (msg.error) errorRef.current(msg.error)
    })
    const unsubPr = client.subscribe('git_pr_content', (msg) => {
      if (msg.dir !== repoDir) return
      setComposeGenerating(false)
      if (msg.title || msg.body) {
        setComposeTitle(msg.title ?? '')
        setComposeBody(msg.body ?? '')
        setComposeError(null)
      }
      if (msg.error) setComposeError(msg.error)
    })
    // The compose modal closes on the pr_create receipt itself: a success
    // carries the pull request, a failure carries gh's own sentence.
    const unsubCreate = client.subscribe('pr_create', (msg) => {
      if (msg.dir !== repoDir) return
      pendingCompose.current = null
      setComposeCreating(false)
      if (msg.pr) {
        setComposeOpen(false)
        setComposeError(null)
      } else if (msg.message) {
        setComposeError(msg.message)
      }
    })
    return () => {
      unsubCommit()
      unsubPr()
      unsubCreate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and setters are stable identities
  }, [client, repoDir])

  useEffect(() => {
    setComposeOpen(false)
    setComposeGenerating(false)
    setComposeCreating(false)
    setComposeError(null)
  }, [repoDir])

  const generateCommit = useCallback((): void => {
    if (!client || !repoDir || generatingCommit) return
    setGeneratingCommit(true)
    onCommitError(null)
    client.gitCommitMessage(repoDir)
  }, [client, repoDir, generatingCommit, onCommitError])

  const openCompose = useCallback((): void => {
    if (!client || !repoDir || !offered) return
    setComposeTitle('')
    setComposeBody('')
    setComposeError(null)
    setComposeOpen(true)
  }, [client, repoDir, offered])

  const generatePrContent = useCallback((): void => {
    if (!client || !repoDir || composeGenerating) return
    setComposeGenerating(true)
    setComposeError(null)
    client.gitPrContent(repoDir)
  }, [client, repoDir, composeGenerating])

  const createComposedPr = useCallback(
    (title: string, body: string): void => {
      if (!client || !repoDir || composeCreating) return
      setComposeCreating(true)
      setComposeError(null)
      pendingCompose.current = repoDir
      client.prCreate(repoDir, title, body)
    },
    [client, repoDir, composeCreating, pendingCompose]
  )

  const cancelCompose = useCallback((): void => {
    setComposeOpen(false)
    setComposeCreating(false)
    setComposeError(null)
  }, [])

  const composeFailed = useCallback(
    (message: string): void => {
      pendingCompose.current = null
      setComposeCreating(false)
      setComposeError(message)
    },
    [pendingCompose]
  )

  return {
    generatingCommit,
    generateCommit,
    compose: {
      open: composeOpen,
      title: composeTitle,
      body: composeBody,
      generating: composeGenerating,
      creating: composeCreating,
      error: composeError
    },
    openCompose,
    generatePrContent,
    createComposedPr,
    cancelCompose,
    composeFailed
  }
}
