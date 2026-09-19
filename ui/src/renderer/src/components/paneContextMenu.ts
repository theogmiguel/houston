import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface PaneMenuState {
  x?: number
  right?: number
  y: number
  originX: string
  originY: string
}

export interface PaneContextMenu {
  menu: PaneMenuState | null
  openMenuAt: (x: number, y: number) => void
  openMenuAtButton: (rect: DOMRect) => void
  closeMenu: () => void
  menuItem: (action: () => void) => () => void
  subMenuItem: (action: () => void) => (e: React.MouseEvent) => void
  menuRef: React.RefObject<HTMLDivElement | null>
  flipSub: boolean
}

export function usePaneContextMenu(onOpen?: () => void): PaneContextMenu {
  const [menu, setMenu] = useState<PaneMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuClamped, setMenuClamped] = useState(false)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('blur', close)
    return () => window.removeEventListener('blur', close)
  }, [menu])

  useLayoutEffect(() => {
    if (!menu || menu.x === undefined || menuClamped) return
    const el = menuRef.current
    if (!el) return
    const width = el.getBoundingClientRect().width
    if (width === 0) return
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))
    setMenuClamped(true)
    if (x !== menu.x) {
      setMenu({ x, y: menu.y, originX: `${parseFloat(menu.originX) + menu.x - x}px`, originY: menu.originY })
    }
  }, [menu, menuClamped])

  const openMenuAt = (x: number, y: number): void => {
    const menuX = Math.min(x, window.innerWidth - 200)
    const menuY = Math.max(8, Math.min(y, window.innerHeight - 440))
    setMenu({
      x: menuX,
      y: menuY,
      originX: `${x - menuX}px`,
      originY: `${y - menuY}px`
    })
    setMenuClamped(false)
    onOpen?.()
  }

  const openMenuAtButton = (rect: DOMRect): void => {
    setMenu({
      right: window.innerWidth - rect.right,
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 440)),
      originX: 'right',
      originY: 'top'
    })
    setMenuClamped(true)
    onOpen?.()
  }

  const closeMenu = (): void => setMenu(null)

  const menuItem = (action: () => void) => () => {
    setMenu(null)
    action()
  }
  const subMenuItem = (action: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenu(null)
    action()
  }

  const flipSub = menu ? menu.x === undefined || menu.x > window.innerWidth - 380 : false

  return { menu, openMenuAt, openMenuAtButton, closeMenu, menuItem, subMenuItem, menuRef, flipSub }
}
