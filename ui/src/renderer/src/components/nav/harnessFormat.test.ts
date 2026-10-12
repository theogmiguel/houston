import { afterEach, expect, it, vi } from 'vitest'
import { formatDay } from './harnessFormat'

afterEach(() => vi.restoreAllMocks())

it('formats review days in English whatever the system locale is', () => {
  const real = Date.prototype.toLocaleDateString
  vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (this: Date, locales, options) {
    return real.call(this, locales ?? 'pt-BR', options)
  })
  expect(formatDay(Date.UTC(2026, 9, 8, 12))).toBe('Oct 8, 2026')
})
