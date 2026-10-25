import { afterEach } from 'vitest'
import { flushLayoutSaves } from '../layout/tree'

// Layout saves land 300 ms after the last change. Each test ends with them written, as
// when saving was synchronous, so a pending save cannot land in the next test's storage.
afterEach(() => {
  flushLayoutSaves()
})
