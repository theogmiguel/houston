import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient } from './client'
import type { HarnessFinding } from './generated/HarnessFinding'
import type { HarnessReview } from './generated/HarnessReview'
import type { HarnessModelOption } from './generated/HarnessModelOption'
import type { Routine } from './generated/Routine'

export interface HarnessState {
  workspace: string
  routine: Routine | null
  reviews: HarnessReview[]
  findings: HarnessFinding[]
  models: HarnessModelOption[]
}

export interface HarnessReport {
  reviewId: number
  markdown: string
  truncated: boolean
}

type WorkspaceHarnessReport = HarnessReport & { workspace: string }

export interface HarnessReportError {
  workspace: string
  reviewId: number
  message: string
}

/// A workspace's reviews, re-read whenever the daemon says they changed or a
/// routine mutation may have changed the review routine.
export function useHarness(
  client: HoustonClient | null,
  workspace: string | null
): {
  state: HarnessState | null
  report: HarnessReport | null
  reportError: HarnessReportError | null
  loadReport: (reviewId: number) => void
} {
  const [state, setState] = useState<HarnessState | null>(null)
  const [report, setReport] = useState<WorkspaceHarnessReport | null>(null)
  const [reportError, setReportError] = useState<HarnessReportError | null>(null)
  const reportRequest = useRef<{ workspace: string; reviewId: number } | null>(null)

  useEffect(() => {
    setState(null)
    setReport(null)
    setReportError(null)
    reportRequest.current = null
    if (!client || !workspace) return
    const offState = client.subscribe('harness_state', (msg) => {
      if (msg.workspace !== workspace) return
      setState({
        workspace: msg.workspace,
        routine: msg.routine ?? null,
        reviews: msg.reviews,
        findings: msg.findings,
        models: msg.models
      })
    })
    const offChanged = client.subscribe('harness_changed', (msg) => {
      if (msg.workspace === workspace) client.harnessState(workspace)
    })
    const offRoutines = client.subscribe('routines', () => client.harnessState(workspace))
    const offReport = client.subscribe('harness_report', (msg) => {
      const request = reportRequest.current
      if (request?.workspace !== workspace || request.reviewId !== msg.review_id) return
      setReportError(null)
      setReport({
        workspace,
        reviewId: msg.review_id,
        markdown: msg.markdown,
        truncated: msg.truncated
      })
    })
    const offError = client.subscribe('error', (msg) => {
      const request = reportRequest.current
      if (request?.workspace !== workspace || msg.context !== `harness_report:${request.reviewId}`) return
      setReport(null)
      setReportError({ workspace, reviewId: request.reviewId, message: msg.message })
    })
    client.harnessState(workspace)
    return () => {
      offState()
      offChanged()
      offRoutines()
      offReport()
      offError()
    }
  }, [client, workspace])

  const loadReport = useCallback(
    (reviewId: number) => {
      if (!client || !workspace) return
      reportRequest.current = { workspace, reviewId }
      setReport(null)
      setReportError(null)
      client.harnessReport(reviewId)
    },
    [client, workspace]
  )

  return {
    state: state?.workspace === workspace ? state : null,
    report: report?.workspace === workspace ? report : null,
    reportError: reportError?.workspace === workspace ? reportError : null,
    loadReport
  }
}
