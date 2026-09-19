// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { measureCorners, parseCssColor } from './browserHost'

let mounted: HTMLElement[] = []

afterEach(() => {
  for (const el of mounted) el.remove()
  mounted = []
})

function mountPane(options: {
  radius?: string
  borderWidth?: string
  borderColor?: string
  surround?: string
  withPaneClass?: boolean
}): HTMLElement {
  const grid = document.createElement('div')
  grid.style.backgroundColor = options.surround ?? 'rgb(10, 10, 12)'
  const pane = document.createElement('section')
  if (options.withPaneClass !== false) pane.className = 'pane browser'
  pane.style.borderBottomWidth = options.borderWidth ?? '1px'
  pane.style.borderBottomColor = options.borderColor ?? 'rgb(51, 51, 51)'
  const placeholder = document.createElement('div')
  placeholder.style.borderBottomLeftRadius = options.radius ?? '9px'
  pane.appendChild(placeholder)
  grid.appendChild(pane)
  document.body.appendChild(grid)
  mounted.push(grid)
  return placeholder
}

describe('parseCssColor', () => {
  it('reads the legacy comma syntax both engines serialize computed colours as', () => {
    expect(parseCssColor('rgb(255, 0, 51)')).toEqual([1, 0, 0.2, 1])
    expect(parseCssColor('rgba(0, 255, 0, 0.5)')).toEqual([0, 1, 0, 0.5])
  })

  it('reads the modern space/slash syntax too', () => {
    expect(parseCssColor('rgb(255 0 51)')).toEqual([1, 0, 0.2, 1])
    expect(parseCssColor('rgb(0 255 0 / 0.5)')).toEqual([0, 1, 0, 0.5])
  })

  it('reads the color(srgb ...) form a wide-gamut authoring form can produce', () => {
    expect(parseCssColor('color(srgb 1 0 0.2)')).toEqual([1, 0, 0.2, 1])
    expect(parseCssColor('color(srgb 0 1 0 / 0.25)')).toEqual([0, 1, 0, 0.25])
  })

  it('reads the transparent keyword, which is what an unpainted ancestor returns', () => {
    expect(parseCssColor('transparent')).toEqual([0, 0, 0, 0])
  })

  it('returns null rather than guessing at anything else', () => {
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor('rebeccapurple')).toBeNull()
    expect(parseCssColor('rgb(255, 0)')).toBeNull()
    expect(parseCssColor('oklch(0.7 0.1 200)')).toBeNull()
  })
})

describe('measureCorners', () => {
  it('reads the radius from the placeholder and the border from the pane', () => {
    const placeholder = mountPane({
      radius: '9px',
      borderWidth: '1px',
      borderColor: 'rgb(51, 51, 51)',
      surround: 'rgb(10, 10, 12)'
    })
    expect(measureCorners(placeholder)).toEqual({
      radius: 9,
      borderWidth: 1,
      border: [51 / 255, 51 / 255, 51 / 255, 1],
      surround: [10 / 255, 10 / 255, 12 / 255, 1]
    })
  })

  it('reports no corners at all for a square placeholder', () => {
    expect(measureCorners(mountPane({ radius: '0px' }))).toBeUndefined()
  })

  it('reports no corners when the placeholder is not inside a pane', () => {
    expect(measureCorners(mountPane({ withPaneClass: false }))).toBeUndefined()
  })

  it('skips a transparent ancestor and takes the first one that paints', () => {
    const placeholder = mountPane({ surround: 'rgb(20, 21, 22)' })
    const grid = placeholder.closest('.pane')?.parentElement
    const passthrough = document.createElement('div')
    passthrough.style.backgroundColor = 'transparent'
    grid?.insertBefore(passthrough, placeholder.closest('.pane'))
    passthrough.appendChild(placeholder.closest('.pane') as HTMLElement)
    expect(measureCorners(placeholder)?.surround).toEqual([20 / 255, 21 / 255, 22 / 255, 1])
  })

  it('reports no corners when a colour cannot be resolved', () => {
    const placeholder = mountPane({ borderColor: 'oklch(0.7 0.1 200)' })
    expect(measureCorners(placeholder)).toBeUndefined()
  })

  it('survives an element with no computed style rather than failing a mount', () => {
    const orphan = document.createElement('div')
    expect(() => measureCorners(orphan)).not.toThrow()
    expect(measureCorners(orphan)).toBeUndefined()
  })
})
