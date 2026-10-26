import { useEffect, useRef, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { DefectDestination } from '../../houston/generated/DefectDestination'
import type { DefectIssueMatch } from '../../houston/generated/DefectIssueMatch'
import type { SuspectedDefect } from '../../houston/generated/SuspectedDefect'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import { Button, Caption, Card, Drawer, Field, InlineLink, Notice, Text, TextArea, TextInput } from '../ui'
import { InlineCluster } from '../ui/navText'

type DraftReply = Extract<ServerMsg, { type: 'defect_issue_draft' }>
type FiledReply = Extract<ServerMsg, { type: 'defect_issue_filed' }>

let nextDefectRequest = 0

function defectRequestId(): number {
  nextDefectRequest += 1
  return nextDefectRequest
}

function destinationName(destination: DefectDestination): string {
  return destination === 'houston' ? "Houston's repository" : "This workspace's repository"
}

function confirmLabel(pending: boolean, commentOn: number | null): string {
  if (pending) return 'Sending…'
  return commentOn === null ? 'Create issue' : `Add comment to #${commentOn}`
}

function filedHeading(filed: FiledReply, comment: boolean): string {
  return comment ? `Comment added to #${filed.number}` : `Issue #${filed.number} created`
}

/** The issue an agent-reported or detected defect would become. Nothing leaves the
 *  machine until the explicit button below sends `defect_issue_file`. */
export function DefectIssueDrawer({
  client,
  defect,
  onClose
}: {
  client: HoustonClient | null
  defect: SuspectedDefect | null
  onClose: () => void
}): React.JSX.Element {
  const workspace = defect?.workspace ?? null
  const key = defect?.key ?? null
  const [draft, setDraft] = useState<DraftReply | null>(null)
  const [filed, setFiled] = useState<FiledReply | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [commentOn, setCommentOn] = useState<number | null>(null)
  const fileRequest = useRef<number | null>(null)

  useEffect(() => {
    setDraft(null)
    setFiled(null)
    setError(null)
    setPending(false)
    setTitle('')
    setBody('')
    setCommentOn(null)
    fileRequest.current = null
    if (!client || !workspace || !key) return
    const request = defectRequestId()
    const offDraft = client.subscribe('defect_issue_draft', (msg) => {
      if (msg.workspace !== workspace || msg.key !== key || msg.request !== request) return
      setError(null)
      setDraft(msg)
      setTitle(msg.title)
      setBody(msg.body)
    })
    const offFiled = client.subscribe('defect_issue_filed', (msg) => {
      if (msg.workspace !== workspace || msg.key !== key || msg.request !== fileRequest.current) return
      setError(null)
      setPending(false)
      setFiled(msg)
    })
    const offError = client.subscribe('error', (msg) => {
      // The daemon names the request kind when it can; a defect draft or filing
      // failure can also arrive without a context, while this drawer is open.
      if (msg.context !== null && !msg.context.includes('defect')) return
      setError(msg.message)
      setPending(false)
    })
    client.defectIssueDraft(workspace, key, request)
    return () => {
      offDraft()
      offFiled()
      offError()
    }
  }, [client, workspace, key])

  function confirm(): void {
    if (!client || !workspace || !key || !draft) return
    const request = defectRequestId()
    fileRequest.current = request
    setPending(true)
    setError(null)
    client.defectIssueFile(workspace, key, request, title, body, draft.destination_repo, commentOn)
  }

  return (
    <Drawer open={defect !== null} heading="Open issue" onClose={onClose}>
      <div className="grid min-w-0 gap-[var(--space-4)]">
        {defect && <Text as="p" size="small" tone="muted" flush>{defect.title}</Text>}
        <DrawerBody
          draft={draft}
          filed={filed}
          error={error}
          pending={pending}
          issueTitle={title}
          body={body}
          commentOn={commentOn}
          onTitle={setTitle}
          onBody={setBody}
          onComment={setCommentOn}
          onConfirm={confirm}
        />
      </div>
    </Drawer>
  )
}

interface DrawerBodyProps {
  draft: DraftReply | null
  filed: FiledReply | null
  error: string | null
  pending: boolean
  issueTitle: string
  body: string
  commentOn: number | null
  onTitle: (value: string) => void
  onBody: (value: string) => void
  onComment: (number: number | null) => void
  onConfirm: () => void
}

function DrawerBody({ draft, filed, error, pending, issueTitle, body, commentOn, onTitle, onBody, onComment, onConfirm }: DrawerBodyProps): React.JSX.Element {
  if (filed) return <FiledBody filed={filed} comment={commentOn !== null} />
  if (!draft) {
    if (error) return <Notice tone="danger" variant="callout" data-testid="defect-draft-refusal">{error}</Notice>
    return <Text role="status" aria-busy="true" tone="muted">Preparing the draft…</Text>
  }
  return (
    <>
      <Card tone="inset" padding="md" className="grid gap-[var(--space-1-5)]">
        <Text size="small" weight="semibold">{destinationName(draft.destination)}</Text>
        <Text size="small" tone="muted" mono>{draft.destination_repo}</Text>
      </Card>
      {draft.note && <Notice tone="warn">{draft.note}</Notice>}
      {error && <Notice tone="danger" variant="callout" data-testid="defect-file-refusal">{error}</Notice>}
      <Field label="Title">
        <TextInput surface="card" width="full" value={issueTitle} maxLength={256} onChange={(event) => onTitle(event.target.value)} />
      </Field>
      <Field label="Body" hint="Edit anything before it is sent. Paths are workspace-relative and secrets are already redacted.">
        <TextArea recipe="field" rows={14} value={body} onChange={(event) => onBody(event.target.value)} />
      </Field>
      <DuplicateChoices duplicates={draft.duplicates} commentOn={commentOn} onComment={onComment} />
      <Card tone="inset" padding="md" className="grid gap-[var(--space-1-5)]">
        <Text size="small" weight="semibold">What will be sent</Text>
        <Text size="small" tone="secondary">{draft.transmits}</Text>
        {draft.account && <Caption>Signed in to gh as {draft.account}.</Caption>}
      </Card>
      <div className="flex justify-end gap-[var(--space-2)]">
        <Button variant="secondary" disabled={pending || issueTitle.trim() === '' || body.trim() === ''} data-testid="defect-file" onClick={onConfirm}>
          {confirmLabel(pending, commentOn)}
        </Button>
      </div>
    </>
  )
}

function FiledBody({ filed, comment }: { filed: FiledReply; comment: boolean }): React.JSX.Element {
  return (
    <Card padding="md" className="grid gap-[var(--space-1-5)]">
      <Text weight="semibold">{filedHeading(filed, comment)}</Text>
      <InlineLink href={filed.issue_url}>{filed.issue_url}</InlineLink>
      {filed.note && <Caption>{filed.note}</Caption>}
    </Card>
  )
}

function DuplicateChoices({
  duplicates,
  commentOn,
  onComment
}: {
  duplicates: DefectIssueMatch[]
  commentOn: number | null
  onComment: (number: number | null) => void
}): React.JSX.Element | null {
  if (duplicates.length === 0) return null
  return (
    <section aria-label="Matching open issues" className="grid gap-[var(--space-1-5)]">
      <Text size="small" weight="semibold">Matching open issues</Text>
      <Card padding="sm" className="grid">
        {duplicates.map((match) => (
          <DuplicateChoice key={match.number} match={match} chosen={commentOn === match.number} onChoose={() => onComment(match.number)} />
        ))}
      </Card>
      {commentOn !== null && (
        <Text size="small" tone="muted">
          The body above becomes a comment on #{commentOn}.{' '}
          <Button variant="body-link" size="sm" onClick={() => onComment(null)}>Create a new issue instead</Button>
        </Text>
      )}
    </section>
  )
}

function DuplicateChoice({ match, chosen, onChoose }: { match: DefectIssueMatch; chosen: boolean; onChoose: () => void }): React.JSX.Element {
  return (
    <InlineCluster insetBlock className="min-w-0">
      <Text size="small" className="min-w-0 flex-1">{`#${match.number} ${match.title}`}</Text>
      <Button variant="ghost" size="sm" disabled={chosen} onClick={onChoose}>
        {chosen ? `Commenting on #${match.number}` : `Comment on #${match.number} instead`}
      </Button>
    </InlineCluster>
  )
}
