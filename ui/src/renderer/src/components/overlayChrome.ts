import type { CSSProperties } from 'react'
import { MATERIAL_CLS, materialAttrs } from './material'

export const POP_ORIGIN_CLS = '[transform-origin:var(--pop-origin-x,center)_var(--pop-origin-y,center)]'

export function popOriginStyle(x: string, y: string): CSSProperties {
  return { ['--pop-origin-x' as string]: x, ['--pop-origin-y' as string]: y } as CSSProperties
}

const OVERLAY_STRUCTURE_CLS =
  'rounded-[var(--tr-radius-md)] [-webkit-app-region:no-drag] select-text ' +
  `${POP_ORIGIN_CLS} ` +
  'motion-safe:[animation:menu-in_var(--animate-t-fast)_var(--animate-ease-menu)]'

export const OVERLAY_RAISED_CLS = `${OVERLAY_STRUCTURE_CLS} ${MATERIAL_CLS.raised}`

export const OVERLAY_OVERLAY_CLS = `${OVERLAY_STRUCTURE_CLS} ${MATERIAL_CLS.overlay}`

export const OVERLAY_GLASS_RAISED_CLS = `${OVERLAY_STRUCTURE_CLS} ${MATERIAL_CLS['raised-glass']}`

export const OVERLAY_GLASS_OVERLAY_CLS = `${OVERLAY_STRUCTURE_CLS} ${MATERIAL_CLS['overlay-glass']}`

export const MODAL_SCRIM_CLS =
  'pop-backdrop fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-overlay backdrop-blur-sm pt-0 ' +
  'motion-safe:animate-[backdrop-in_var(--animate-t-scrim)_var(--animate-ease-scrim)] ' +
  '[.anim-out_&]:motion-safe:animate-[backdrop-out_var(--animate-t-scrim)_var(--animate-ease-scrim)_forwards]'

export const OVERLAY_RAISED_ATTRS = Object.freeze(materialAttrs('raised'))
export const OVERLAY_OVERLAY_ATTRS = Object.freeze(materialAttrs('overlay'))
export const OVERLAY_GLASS_RAISED_ATTRS = Object.freeze(materialAttrs('raised-glass'))
export const OVERLAY_GLASS_OVERLAY_ATTRS = Object.freeze(materialAttrs('overlay-glass'))
