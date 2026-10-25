import { memo, useState } from 'react'
import { QuestionCard } from '../QuestionCard'
import { Button } from '../ui/Button'
import { ThreadCaption, ThreadQuestionDock, ThreadQuestionRecord } from '../ui/Thread'
import { Tooltip } from '../ui/Tooltip'
import { THREAD_QUESTION_OTHER_MAX_BYTES } from '../../houston/generated/DEFAULTS'
import type { ThreadItem } from '../../thread/threadModel'
import type { QuestionAnswer, ThreadQuestion } from '../../thread/threadTypes'

type QuestionItem = Extract<ThreadItem, { kind: 'question' }>

/** One question's answer in progress: chosen labels and the user's own text. */
export interface QuestionDraft {
  selected: readonly string[]
  other: string
  typing: boolean
}

const EMPTY_DRAFT: QuestionDraft = { selected: [], other: '', typing: false }

/** Why this answer cannot be sent yet, or `null` when it can. */
export function draftProblem(question: ThreadQuestion, draft: QuestionDraft): string | null {
  const other = draft.other.trim()
  const size = new TextEncoder().encode(other).length
  if (size > THREAD_QUESTION_OTHER_MAX_BYTES) return `Your answer to "${question.question}" is ${size.toLocaleString()} bytes; an answer is limited to ${THREAD_QUESTION_OTHER_MAX_BYTES.toLocaleString()} bytes`
  if (draft.selected.length === 0 && other === '') return `Choose or type an answer to "${question.question}" first`
  return null
}

/** The answers `thread_answer` sends, one per question in order. */
export function draftAnswers(questions: readonly ThreadQuestion[], drafts: readonly QuestionDraft[]): QuestionAnswer[] {
  return questions.map((question, i) => {
    const draft = drafts[i] ?? EMPTY_DRAFT
    const other = draft.other.trim()
    return { question: question.question, selected: [...draft.selected], other: other === '' ? null : other }
  })
}

/** The answer as Claude reads it: the labels, then the user's own text, joined with ", ". */
export function answerText(answer: QuestionAnswer): string {
  return [...answer.selected, ...(answer.other ? [answer.other] : [])].join(', ')
}

/** The held question above the composer: one page per question, then Submit; Skip answers none. */
export function ThreadQuestionPrompt({ item, answering, connected, onAnswer }: {
  item: QuestionItem
  answering: boolean
  connected: boolean
  onAnswer: (requestId: string, answers: QuestionAnswer[] | null) => void
}): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<readonly QuestionDraft[]>(() => item.questions.map(() => EMPTY_DRAFT))
  const question = item.questions[index]!
  const draft = drafts[index] ?? EMPTY_DRAFT
  const update = (change: Partial<QuestionDraft>): void => setDrafts((current) => current.map((d, i) => (i === index ? { ...d, ...change } : d)))
  const lockedReason = answering ? 'Sending your answer…' : connected ? null : 'Reconnecting to the daemon'
  const last = index === item.questions.length - 1
  const here = draftProblem(question, draft)
  const blocked = item.questions.map((q, i) => draftProblem(q, drafts[i] ?? EMPTY_DRAFT)).find((problem) => problem !== null) ?? null
  const single = !question.multi_select
  return (
    <ThreadQuestionDock>
      <QuestionCard
        questionIndex={index + 1}
        questionCount={item.questions.length}
        question={question.question}
        header={question.header || undefined}
        body={draft.typing ? 'free-text' : single ? 'single-select' : 'multi-select'}
        options={question.options.map((option) => ({ id: option.label, label: option.label, description: option.description }))}
        selectedId={draft.selected[0]}
        selectedIds={[...draft.selected]}
        freeTextValue={draft.other}
        onFreeTextChange={(other) => update({ other })}
        onSelectOption={(label) => update({ selected: [label], other: '' })}
        onToggleOption={(label) => update({ selected: draft.selected.includes(label) ? draft.selected.filter((s) => s !== label) : [...draft.selected, label] })}
        onTypeInstead={() => update(single ? { typing: true, selected: [] } : { typing: true })}
        onSkip={() => onAnswer(item.requestId, null)}
        disabled={lockedReason !== null}
        disabledReason={lockedReason ?? undefined}
        actions={
          <div className="flex items-center justify-end gap-[var(--space-2)]">
            {draft.typing && <Button variant="ghost" size="sm" disabled={lockedReason !== null} onClick={() => update({ typing: false })}>Show options</Button>}
            {index > 0 && <Button data-testid="question-card-back" variant="secondary" size="sm" disabled={lockedReason !== null} onClick={() => setIndex(index - 1)}>Back</Button>}
            {last ? (
              <Tooltip label={lockedReason ?? blocked} className="inline-flex">
                <Button data-testid="question-card-submit" variant="primary" size="sm" disabled={lockedReason !== null || blocked !== null} onClick={() => onAnswer(item.requestId, draftAnswers(item.questions, drafts))}>Submit</Button>
              </Tooltip>
            ) : (
              <Tooltip label={lockedReason ?? here} className="inline-flex">
                <Button data-testid="question-card-next" variant="primary" size="sm" disabled={lockedReason !== null || here !== null} onClick={() => setIndex(index + 1)}>Next</Button>
              </Tooltip>
            )}
          </div>
        }
      />
    </ThreadQuestionDock>
  )
}

/** The question in the timeline, with the user's answers once given. */
export const ThreadQuestionRow = memo(function ThreadQuestionRow({ item }: { item: QuestionItem }): React.JSX.Element {
  const lines = item.questions.map((q) => {
    const answer = item.answers.find((a) => a.question === q.question)
    return answer ? { question: q.question, answer: answerText(answer) } : { question: q.question }
  })
  return (
    <>
      <ThreadQuestionRecord lines={lines} state={item.state} reason={item.reason} />
      {item.truncated && <ThreadCaption>A header or option description was cut at 2 KiB by Houston.</ThreadCaption>}
    </>
  )
})
