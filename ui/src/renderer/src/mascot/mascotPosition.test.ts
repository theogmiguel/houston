// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { FLOATING_MARGIN, FLOATING_SIZE, MASCOT_POSITION_KEY, RAIL_POSITION, boxesIntersect, clampMascotPoint, floatingPosition, mascotPositionPoint, nearestMascotPoint, readMascotPosition, resolveMascotDrop, writeMascotPosition } from './mascotPosition'
const bounds = { x: 0, y: 0, width: 1000, height: 700 }

describe('mascot position', () => {
  it('round trips fractions independently of the director ledger', () => {
    const ledger = JSON.stringify({ periods: [], speech: [], lastBreakAt: 0, introSeen: true, installDate: '2026-01-01' })
    const data = new Map([['tr-mascot-ledger', ledger]])
    const storage = { getItem: (key: string): string | null => data.get(key) ?? null, setItem: (key: string, value: string): void => { data.set(key, value) } }
    const position = floatingPosition({ x: 375, y: 280 }, bounds)
    writeMascotPosition(storage, position)
    expect(readMascotPosition(storage)).toEqual({ kind: 'floating', x: .375, y: .4 })
    expect(data.get('tr-mascot-ledger')).toBe(ledger)
    writeMascotPosition(storage, RAIL_POSITION)
    expect(readMascotPosition(storage)).toEqual(RAIL_POSITION)
    expect(data.has(MASCOT_POSITION_KEY)).toBe(true)
  })
  it.each(['bad json', 'null', '{}', '{"kind":"floating","x":-1,"y":0}', '{"kind":"floating","x":0,"y":1.1}', '{"kind":"floating","x":"0.5","y":0}', '{"kind":"floating","x":0}', '{"kind":"floating","x":1e999,"y":0}', '{"kind":"other","x":0,"y":0}'])('validates stored position %s', raw => {
    expect(readMascotPosition({ getItem: () => raw })).toEqual(RAIL_POSITION)
  })
  it('falls back without available storage', () => {
    expect(readMascotPosition({ getItem: () => { throw new Error('unavailable') } })).toEqual(RAIL_POSITION)
  })
  it('clamps on load and resize, keeping the whole mascot and margin visible', () => {
    const edge = readMascotPosition({ getItem: () => '{"kind":"floating","x":1,"y":1}' })
    expect(mascotPositionPoint(edge, bounds)).toEqual({ x: 924, y: 624 })
    const smaller = { ...bounds, width: 300, height: 200 }
    expect(mascotPositionPoint(edge, smaller)).toEqual({ x: 224, y: 124 })
    expect(clampMascotPoint({ x: -500, y: -500 }, smaller)).toEqual({ x: FLOATING_MARGIN, y: FLOATING_MARGIN })
    expect(mascotPositionPoint({ kind: 'floating', x: .4, y: .5 }, smaller)).toEqual({ x: 120, y: 100 })
  })
  it('docks when the pointer or mascot overlaps the rail slot', () => {
    const rail = { x: 8, y: 600, width: 220, height: 74 }
    expect(resolveMascotDrop({ x: 180, y: 610 }, { x: 212, y: 630 }, rail, bounds, [])).toEqual(RAIL_POSITION)
    expect(resolveMascotDrop({ x: 225, y: 580 }, { x: 255, y: 590 }, rail, bounds, [])).toEqual(RAIL_POSITION)
    expect(resolveMascotDrop({ x: 400, y: 200 }, { x: 425, y: 225 }, rail, bounds, [])).toEqual({ kind: 'floating', x: .4, y: 200 / 700 })
  })
  it('finds the nearest free position outside native browsers, including overlapping surfaces', () => {
    const browser = { x: 200, y: 100, width: 500, height: 500 }
    expect(nearestMascotPoint({ x: 220, y: 300 }, bounds, [browser])).toEqual({ x: 136, y: 300 })
    const browsers = [browser, { x: 80, y: 250, width: 120, height: 250 }]
    const point = nearestMascotPoint({ x: 220, y: 300 }, bounds, browsers)!
    expect(point).toEqual({ x: 136, y: 186 })
    expect(browsers.some(box => boxesIntersect({ ...point, width: FLOATING_SIZE, height: FLOATING_SIZE }, box))).toBe(false)
  })
  it('returns to the rail when no visible position outside a native browser exists', () => {
    expect(nearestMascotPoint({ x: 200, y: 200 }, bounds, [bounds])).toBeNull()
    expect(resolveMascotDrop({ x: 200, y: 200 }, { x: 232, y: 232 }, null, bounds, [bounds])).toEqual(RAIL_POSITION)
  })
})
