import { useEffect, useState } from 'react'
import type { HoustonClient } from '../../houston/client'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { TaskRefusal } from '../../houston/useTasks'
import { sendTaskWire } from '../../houston/taskDomain'
import { QuestionCard } from '../QuestionCard'
import { Button, Inline, QuestionNote, TaskSectionLabel, Text } from '../ui'

export type TaskQuestion = NonNullable<TaskSummary['open_question']>

// An agent's open question. An option sends its text, which the daemon types
// into the pane once the agent is idle; free text is typed in the pane itself.
// `keyboard` is off where several cards share a page.
export function TaskQuestionCard({ question, client, refusal, onOpenSession, labelled = true, keyboard = true }: {
  question: TaskQuestion
  client: Pick<HoustonClient, 'send'> | null
  refusal: TaskRefusal | null
  onOpenSession: (sessionId: number) => void
  labelled?: boolean
  keyboard?: boolean
}): React.JSX.Element {
  const [sentId, setSentId] = useState<string | undefined>(undefined)
  // A refusal of this task re-enables the options so the answer can be sent again.
  const ownRefusal = refusal?.id === question.task_id ? refusal : null
  useEffect(() => {
    setSentId(undefined)
  }, [question.id, ownRefusal])
  const options = question.options.map((text, index) => ({
    id: String(index),
    label: question.recommended === index + 1 ? `${text} · Recommended` : text
  }))
  const answer = (id: string): void => {
    const text = question.options[Number(id)]
    if (!client || sentId !== undefined || text === undefined) return
    setSentId(id)
    sendTaskWire(client, { type: 'task_question_answer', question_id: question.id, answer: text })
  }
  const openPane = (): void => onOpenSession(question.session_id)
  const notes = question.why || question.context ? <>
    {question.why && <QuestionNote>Why: {question.why}</QuestionNote>}
    {question.context && <QuestionNote>Context: {question.context}</QuestionNote>}
  </> : undefined

  return <section className="grid gap-[var(--space-2)]" aria-label="Agent question" data-testid="task-question">
    {labelled && <TaskSectionLabel heading="Agent question" />}
    <QuestionCard
      questionIndex={1}
      questionCount={1}
      question={question.question}
      body="single-select"
      options={options}
      selectedId={sentId}
      notes={notes}
      skippable={false}
      keyboard={keyboard}
      disabled={!client || sentId !== undefined}
      disabledReason={sentId !== undefined ? 'Answer sent' : 'Not connected to Houston'}
      onSelectOption={answer}
      onTypeInstead={openPane}
    />
    {sentId !== undefined && <Text role="status" size="small" tone="muted">Answer sent. Houston types it into the pane when the agent is idle.</Text>}
    <Inline gap="small"><Button variant="secondary" data-testid="task-question-open-pane" onClick={openPane}>Open pane</Button></Inline>
  </section>
}
