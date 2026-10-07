import { useEffect, useRef, useState } from 'react'
import type { HoustonClient, PrCheck } from '../../houston/client'
import { ChecksList, checkKey, type CheckAgentTarget, type CheckLogState, type ChecksListProps } from './ChecksList'

export interface UsePrChecksStateOptions {
  client: HoustonClient | null
  dir: string | null
  number: number
  url: string
  branch: string | null
  checks: PrCheck[]
  agents?: CheckAgentTarget[]
  onPasteToAgent?: (session: number, text: string) => void
  onCreateAgent?: (provider: string, text: string) => Promise<number | null>
  onOpenUrl?: (url: string) => void
  onOpenPane?: (session: number) => void
}

export interface PrChecksState {
  failedCount: number
  passedCount: number
  sectionOpen: boolean
  setSectionOpen: React.Dispatch<React.SetStateAction<boolean>>
  popoverOpen: boolean
  setPopoverOpen: React.Dispatch<React.SetStateAction<boolean>>
  listProps: ChecksListProps
}

export function usePrChecksState({
  client,
  dir,
  number,
  url,
  branch,
  checks,
  agents = [],
  onPasteToAgent,
  onCreateAgent,
  onOpenUrl,
  onOpenPane,
}: UsePrChecksStateOptions): PrChecksState {
  const failedCount = checks.filter((check) => check.state === 'failing').length
  const passedCount = checks.filter((check) => check.state === 'passing').length
  const firstFailingCheck = checks.find((check) => check.state === 'failing')
  const firstFailingKey = firstFailingCheck ? checkKey(firstFailingCheck) : null
  const [expanded, setExpanded] = useState<string | null>(() => {
    const failing = checks.find((check) => check.state === 'failing')
    return failing ? checkKey(failing) : null
  })
  const [sectionOpen, setSectionOpen] = useState(failedCount > 0)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [picker, setPicker] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, CheckLogState>>({})
  const [sent, setSent] = useState<Record<string, string>>({})
  const [openPaneSessions, setOpenPaneSessions] = useState<Record<string, number>>({})
  const logRefs = useRef(new Map<string, Set<HTMLDivElement>>())
  const requestedLogs = useRef(new Set<string>())

  useEffect(() => {
    if (failedCount > 0) {
      setSectionOpen(true)
      setExpanded((previous) => previous ?? firstFailingKey)
    } else {
      setSectionOpen(false)
      setExpanded(null)
    }
  }, [failedCount, firstFailingKey])

  useEffect(() => {
    if (!client || !dir) return
    return client.subscribe('pr_check_log', (msg) => {
      if (msg.dir !== dir) return
      const key = String(msg.run_id)
      setLogs((previous) => ({
        ...previous,
        [key]: { lines: msg.lines, available: msg.available, loading: false, truncated: msg.truncated },
      }))
    })
  }, [client, dir])

  useEffect(() => {
    if (expanded === null) return
    const check = checks.find((candidate) => checkKey(candidate) === expanded)
    if (!check || logs[expanded] || requestedLogs.current.has(expanded)) return
    requestedLogs.current.add(expanded)
    if (!client || !dir || check.run_id == null) {
      setLogs((previous) => ({
        ...previous,
        [expanded]: { lines: [], available: false, loading: false, truncated: false },
      }))
      return
    }
    setLogs((previous) => ({
      ...previous,
      [expanded]: { lines: [], available: false, loading: true, truncated: false },
    }))
    client.prCheckLog(dir, check.run_id)
  }, [checks, client, dir, expanded, logs])

  useEffect(() => {
    if (expanded === null) return
    for (const node of logRefs.current.get(expanded) ?? []) node.scrollTop = node.scrollHeight
  }, [expanded, logs])

  const toggle = (check: PrCheck): void => {
    const key = checkKey(check)
    if (expanded === key) {
      setExpanded(null)
      setPicker(null)
      return
    }
    setExpanded(key)
    setPicker(null)
  }

  const promptFor = (check: PrCheck): string => {
    const log = logs[checkKey(check)]
    return [
      `Please investigate this failing check: ${check.name}`,
      `Pull request: #${number} ${url}`,
      `Branch: ${branch ?? 'unknown'}`,
      `Check run: ${check.url ?? 'not available'}`,
      'Failure log tail:',
      log?.available ? log.lines.slice(-40).join('\n') : "Logs aren't available for this check",
    ].join('\n')
  }

  const send = (check: PrCheck, target: CheckAgentTarget): void => {
    const prompt = promptFor(check)
    onPasteToAgent?.(target.session, prompt)
    setSent((previous) => ({ ...previous, [checkKey(check)]: target.label }))
    setPicker(null)
  }

  const create = (check: PrCheck, provider: string): void => {
    if (!onCreateAgent) return
    void onCreateAgent(provider, promptFor(check)).then((session) => {
      if (session === null) return
      const key = checkKey(check)
      setSent((previous) => ({ ...previous, [key]: `new ${provider} pane` }))
      setOpenPaneSessions((previous) => ({ ...previous, [key]: session }))
      setPicker(null)
    })
  }

  const listProps: ChecksListProps = {
    checks,
    logs,
    expanded,
    picker,
    sent,
    openPaneSessions,
    agents,
    onToggle: toggle,
    onPickAgent: (check) => setPicker((previous) => (previous === checkKey(check) ? null : checkKey(check))),
    onSendToAgent: send,
    onCreateAgent: onCreateAgent ? create : undefined,
    onOpenUrl,
    onOpenPane,
    logRefs,
  }
  return { failedCount, passedCount, sectionOpen, setSectionOpen, popoverOpen, setPopoverOpen, listProps }
}

export function PrChecksList({ state }: { state: PrChecksState }): React.JSX.Element {
  return <ChecksList {...state.listProps} />
}
