import { createContext } from 'react'
import type { PaneKey } from './tree'

export const ExpandedContext = createContext<PaneKey | null>(null)
