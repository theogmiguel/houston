import { useEffect, useRef, useState } from 'react'

export type CopyFeedbackState = 'idle' | 'success' | 'error'

const COPY_FEEDBACK_MS = 2000

export function useCopyFeedback(): { copyState: CopyFeedbackState; copy: (text: string) => void } {
  const [copyState, setCopyState] = useState<CopyFeedbackState>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tokenRef = useRef(0)

  useEffect(
    () => () => {
      clearTimeout(timerRef.current)
      tokenRef.current = -1
    },
    []
  )

  const copy = (text: string): void => {
    clearTimeout(timerRef.current)
    const token = ++tokenRef.current
    const writeText =
      typeof navigator !== 'undefined' ? navigator.clipboard?.writeText?.bind(navigator.clipboard) : undefined
    const settle = (state: 'success' | 'error'): void => {
      if (tokenRef.current !== token) return
      setCopyState(state)
      timerRef.current = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS)
    }
    if (!writeText) {
      settle('error')
      return
    }
    writeText(text).then(
      () => settle('success'),
      () => settle('error')
    )
  }

  return { copyState, copy }
}
