import { createContext } from 'react'
export interface MascotRail {
  node: HTMLDivElement
  existingUser: boolean
  firstRun: boolean
}
export const MascotRailContext = createContext<((rail: MascotRail) => () => void) | null>(null)
export const MascotDockContext = createContext<HTMLDivElement | null>(null)
