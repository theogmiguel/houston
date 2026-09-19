// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isTitlebarDragEligible } from './App'

const NO_DRAG_CLASS = '[-webkit-app-region:no-drag]'

function mockEvent(opts: {
  button?: number
  detail?: number
  target: EventTarget | null
}): { button: number; detail: number; target: EventTarget | null } {
  return { button: 0, detail: 1, ...opts }
}

describe('isTitlebarDragEligible (item 19)', () => {
  it('is eligible for a plain left-click on bare titlebar background', () => {
    const bg = document.createElement('div')
    expect(isTitlebarDragEligible(mockEvent({ target: bg }))).toBe(true)
  })

  it('is NOT eligible when the press lands directly on a no-drag button', () => {
    const button = document.createElement('button')
    button.className = NO_DRAG_CLASS
    expect(isTitlebarDragEligible(mockEvent({ target: button }))).toBe(false)
  })

  it('is NOT eligible when the press lands on an icon nested INSIDE a no-drag button', () => {
    const button = document.createElement('button')
    button.className = NO_DRAG_CLASS
    const icon = document.createElement('svg')
    button.appendChild(icon)
    expect(isTitlebarDragEligible(mockEvent({ target: icon }))).toBe(false)
  })

  it('is NOT eligible for a deeply nested icon (span > svg > path)', () => {
    const button = document.createElement('button')
    button.className = NO_DRAG_CLASS
    const span = document.createElement('span')
    const svg = document.createElement('svg')
    const path = document.createElement('path')
    svg.appendChild(path)
    span.appendChild(svg)
    button.appendChild(span)
    expect(isTitlebarDragEligible(mockEvent({ target: path }))).toBe(false)
  })

  it('is eligible for a press on a sibling that is NOT inside any no-drag ancestor', () => {
    const header = document.createElement('header')
    const noDragButton = document.createElement('button')
    noDragButton.className = NO_DRAG_CLASS
    const plainSpan = document.createElement('span')
    header.appendChild(noDragButton)
    header.appendChild(plainSpan)
    expect(isTitlebarDragEligible(mockEvent({ target: plainSpan }))).toBe(true)
  })

  it('is NOT eligible for a non-primary mouse button (middle/right click)', () => {
    const bg = document.createElement('div')
    expect(isTitlebarDragEligible(mockEvent({ target: bg, button: 1 }))).toBe(false)
    expect(isTitlebarDragEligible(mockEvent({ target: bg, button: 2 }))).toBe(false)
  })

  it('is NOT eligible for the second mousedown of a double-click (detail === 2)', () => {
    const bg = document.createElement('div')
    expect(isTitlebarDragEligible(mockEvent({ target: bg, detail: 2 }))).toBe(false)
  })

  it('is NOT eligible for the third mousedown of a triple-click (detail >= 2)', () => {
    const bg = document.createElement('div')
    expect(isTitlebarDragEligible(mockEvent({ target: bg, detail: 3 }))).toBe(false)
    expect(isTitlebarDragEligible(mockEvent({ target: bg, detail: 4 }))).toBe(false)
  })

  it('is NOT eligible for a press on dropdown content nested under a no-drag panel', () => {
    const header = document.createElement('header')
    const panel = document.createElement('div')
    panel.className = `bell-menu ${NO_DRAG_CLASS}`
    const item = document.createElement('div')
    const title = document.createElement('b')
    const timestamp = document.createElement('span')
    item.appendChild(title)
    item.appendChild(timestamp)
    panel.appendChild(item)
    header.appendChild(panel)
    expect(isTitlebarDragEligible(mockEvent({ target: title }))).toBe(false)
    expect(isTitlebarDragEligible(mockEvent({ target: timestamp }))).toBe(false)
    expect(isTitlebarDragEligible(mockEvent({ target: item }))).toBe(false)
  })

  it('is eligible when target is not an Element (defensive fallback)', () => {
    expect(isTitlebarDragEligible(mockEvent({ target: null }))).toBe(true)
  })
})
