import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient, PrListItem, PrListState, PrSort, ServerMsg } from './houston/client'

export function usePullRequestsScreen(client: HoustonClient | null, directory: string | null | undefined, active: boolean) {
  const [items, setItems] = useState<PrListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState<PrListState>('all')
  const [sort, setSort] = useState<PrSort>('updated')
  const [viewerLogin, setViewerLogin] = useState('')
  const lastRequest = useRef<{ request: number; dir: string } | null>(null)
  const lastAuthoredRequest = useRef<{ request: number; dir: string } | null>(null)

  const refresh = useCallback(() => {
    if (!client || !directory) return
    setLoading(true)
    lastRequest.current = { request: client.prList(directory, state, 'all', null, 100, sort), dir: directory }
    lastAuthoredRequest.current = { request: client.prList(directory, 'all', 'authored', null, 1, 'updated'), dir: directory }
  }, [client, directory, sort, state])

  const handleMessage = useCallback((message: ServerMsg): void => {
    if (message.type !== 'pr_list') return
    if (lastAuthoredRequest.current?.request === message.request && lastAuthoredRequest.current.dir === message.dir) {
      setViewerLogin(message.items[0]?.author ?? '')
    } else if (lastRequest.current?.request === message.request && lastRequest.current.dir === message.dir) {
      setItems(message.items)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active || !client || !directory) return
    setViewerLogin('')
    refresh()
  }, [active, client, directory, refresh])

  return { items, loading, state, setState, sort, setSort, viewerLogin, handleMessage, refresh, setLoading }
}
