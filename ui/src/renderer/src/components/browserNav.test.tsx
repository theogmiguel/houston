// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { BrowserState } from '../houston/browserState'
import type { BrowserTab } from './browserTabs'
import { useBrowserNav } from './browserNav'

const native = vi.hoisted(() => ({ state: null as BrowserState | null }))
vi.mock('../houston/host', () => ({ isTauri: () => true }))
vi.mock('../houston/browserState', () => ({ useBrowserState: () => native.state }))

it('keeps requested navigation until native loading finishes and then accepts redirects', () => {
  const oldUrl = 'https://old.example/'
  native.state = {
    id: 'test', url: oldUrl, title: 'Old page', favicon: null,
    loading: false, progress: 1, canGoBack: false, canGoForward: false,
    error: null, mountFailed: false
  }
  const hook = renderHook(() => {
    const [tab, setTab] = useState<BrowserTab>({ id: 1, url: oldUrl })
    const [input, setInput] = useState(oldUrl)
    const [, setError] = useState<string | null>(null)
    const [, setRecents] = useState<string[]>([])
    const nav = useBrowserNav('test', useRef(null), [tab], tab,
      (_id, patch) => setTab((prev) => ({ ...prev, ...patch })),
      setInput, setError, setRecents)
    return { tab, input, nav }
  })
  act(() => hook.result.current.nav.openUrl('https://new.example/'))
  expect(hook.result.current.tab.url).toBe('https://new.example/')
  native.state = { ...native.state, loading: true, progress: 0.02 }
  hook.rerender()
  expect(hook.result.current.tab.url).toBe('https://new.example/')
  expect(hook.result.current.input).toBe('https://new.example/')
  native.state = { ...native.state, url: 'https://redirect.example/', loading: false, progress: 1 }
  hook.rerender()
  expect(hook.result.current.tab.url).toBe('https://redirect.example/')
  expect(hook.result.current.input).toBe('https://redirect.example/')
})
