// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PaneMenuAgentRow } from './PaneMenu'

afterEach(cleanup)

describe('PaneMenuAgentRow', () => {
  it('labels agents with their canonical spelling rather than a CSS-cased id', () => {
    render(
      <>
        <PaneMenuAgentRow agent="opencode" onClick={() => {}} />
        <PaneMenuAgentRow agent="zcode" onClick={() => {}} />
        <PaneMenuAgentRow agent="claude" onClick={() => {}} />
      </>
    )
    expect(screen.getByText('OpenCode')).toBeTruthy()
    expect(screen.getByText('ZCode')).toBeTruthy()
    expect(screen.getByText('Claude Code')).toBeTruthy()
  })
})
