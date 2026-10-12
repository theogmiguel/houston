import { useCallback, useEffect, useRef, useState } from 'react'
import type { HoustonClient, PrListItem, PrListState, PrSort, ServerMsg } from './houston/client'

export function usePullRequestsScreen(client: HoustonClient | null, directory: string | null | undefined, active: boolean) {
  const [items, setItems] = useState<PrListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState<PrListState>('open')
  const [sort, setSort] = useState<PrSort>('updated')
  const [viewerLogin, setViewerLogin] = useState('')
  const lastRequest = useRef<{ request: number; dir: string } | null>(null)

  const refresh = useCallback(() => {
    if (!client || !directory) return
    setLoading(true)
    lastRequest.current = { request: client.prList(directory, state, 'all', null, 100, sort), dir: directory }
  }, [client, directory, sort, state])

  const handleMessage = useCallback((message: ServerMsg): void => {
    if (message.type !== 'pr_list') return
    if (lastRequest.current?.request === message.request && lastRequest.current.dir === message.dir) {
      setViewerLogin(message.viewer_login ?? '')
      setItems(message.items)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    lastRequest.current = null
    setItems([])
    setViewerLogin('')
    if (!active || !client || !directory) { setLoading(false); return }
    refresh()
  }, [active, client, directory, refresh])

  return { items, loading, state, setState, sort, setSort, viewerLogin, handleMessage, refresh, setLoading }
}
