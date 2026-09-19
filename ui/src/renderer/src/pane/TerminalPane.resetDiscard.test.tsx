// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { OutputSink, RegisterOutput } from './TerminalPane'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

const { resetSpy, writeSpy } = ghosttyMock

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const { TerminalPane } = await import('./TerminalPane')

const enc = new TextEncoder()
const dec = new TextDecoder()

function makeSession(): SessionInfo {
  return {
    id: 1,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false
  } as SessionInfo
}

describe('TerminalPane resetAndReattach write-queue discard (item 5b)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let sink: OutputSink | null

  beforeEach(() => {
    ghosttyMock.reset()
    sink = null
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('never lets a frame queued before resetAndReattach reach term.write after the reset', async () => {
    const registerOutput: RegisterOutput = (_id, s) => {
      sink = s
      return () => {
        sink = null
      }
    }

    act(() => {
      root.render(
        <TerminalPane
          client={fakeClient}
          info={makeSession()}
          theme="warm-espresso"
          active={false}
          connected={true}
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={false}
          registerOutput={registerOutput}
          onActivate={() => {}}
          onZoom={() => {}}
          onShellZoom={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })

    expect(sink).not.toBeNull()
    await act(async () => {
      await flushGhosttyAttach()
    })
    expect(writeSpy).not.toHaveBeenCalled()

    act(() => sink!.replay(new Uint8Array(), 0))
    expect(writeSpy).not.toHaveBeenCalled()

    const frameA = enc.encode('AAA')
    act(() => sink!.frame(0, frameA))
    expect(writeSpy).toHaveBeenCalledTimes(1)

    const frameB = enc.encode('BBBBB')
    act(() => sink!.frame(frameA.length, frameB))
    expect(writeSpy).toHaveBeenCalledTimes(1)

    act(() => sink!.gap())
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(fakeClient.attachSession).toHaveBeenCalledTimes(2)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const postResetCalls = writeSpy.mock.calls.slice(1)
    const postResetText = postResetCalls
      .map((c) => dec.decode(c[0] as Uint8Array))
      .join('')
    expect(postResetText).not.toContain('BBBBB')
    expect(postResetText).toContain('discarded 5 bytes')
  })
})
