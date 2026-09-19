import { createContext } from 'react'
import type { KeymapOverrides } from '../houston/generated/KeymapOverrides'

const EMPTY_OVERRIDES: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }

export const KeymapOverridesContext = createContext<KeymapOverrides>(EMPTY_OVERRIDES)
