import { expect, it, vi } from 'vitest'
import { createMascotDrag } from './mascotDrag'
import { RAIL_POSITION } from './mascotPosition'
function fixture() {
  const env = {
    point: () => ({ x: 20, y: 600 }), window: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    rail: () => ({ x: 8, y: 590, width: 220, height: 84 }), browsers: () => [],
    move: vi.fn(), dragging: vi.fn(), save: vi.fn(), docked: vi.fn(), suppressClick: vi.fn()
  }
  return { env, drag: createMascotDrag(env) }
}
it('keeps taps below the threshold available to the existing click handler', () => {
  const { env, drag } = fixture()
  drag.start({ x: 40, y: 620 }); drag.move({ x: 43, y: 622 }); drag.end({ x: 43, y: 622 })
  expect(env.dragging).not.toHaveBeenCalled(); expect(env.save).not.toHaveBeenCalled(); expect(env.suppressClick).not.toHaveBeenCalled()
})
it('lifts beyond the threshold, follows the pointer and persists the final drop without a boing', () => {
  const { env, drag } = fixture()
  drag.start({ x: 40, y: 620 }); drag.move({ x: 500, y: 300 }); drag.end({ x: 510, y: 310 })
  expect(env.dragging.mock.calls).toEqual([[true], [false]])
  expect(env.move).toHaveBeenCalledWith({ x: 480, y: 280 })
  expect(env.save).toHaveBeenCalledWith({ kind: 'floating', x: .49, y: 290 / 700 })
  expect(env.suppressClick).toHaveBeenCalledOnce(); expect(env.docked).not.toHaveBeenCalled()
})
it('returns to the rail with the boing only after a dragged drop on the slot', () => {
  const { env, drag } = fixture()
  drag.start({ x: 40, y: 620 }); drag.move({ x: 500, y: 300 }); drag.move({ x: 80, y: 620 }); drag.end({ x: 80, y: 620 })
  expect(env.save).toHaveBeenCalledWith(RAIL_POSITION)
  expect(env.docked).toHaveBeenCalledWith(40, 0)
})
it('cancels an interrupted drag without changing persisted position or triggering a click', () => {
  const { env, drag } = fixture()
  drag.start({ x: 40, y: 620 }); drag.move({ x: 500, y: 300 }); drag.cancel()
  expect(env.move).toHaveBeenLastCalledWith({ x: 20, y: 600 })
  expect(env.dragging).toHaveBeenLastCalledWith(false)
  expect(env.save).not.toHaveBeenCalled(); expect(env.suppressClick).toHaveBeenCalledOnce()
})
