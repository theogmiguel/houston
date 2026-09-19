export type WindowButtonKind = 'close' | 'minimize' | 'maximize'
export type WindowButtonSide = 'left' | 'right'

export interface WindowButtonLayout {
  side: WindowButtonSide
  buttons: WindowButtonKind[]
}

const KNOWN_BUTTONS = new Set<WindowButtonKind>(['close', 'minimize', 'maximize'])

export const FALLBACK_WINDOW_BUTTON_LAYOUT: WindowButtonLayout = {
  side: 'right',
  buttons: ['minimize', 'maximize', 'close'],
}

function parseSide(raw: string): WindowButtonKind[] {
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token): token is WindowButtonKind => KNOWN_BUTTONS.has(token as WindowButtonKind))
}

export function parseWindowButtonLayout(raw: string | null | undefined): WindowButtonLayout {
  if (!raw) {
    return FALLBACK_WINDOW_BUTTON_LAYOUT
  }

  const colonIndex = raw.indexOf(':')
  if (colonIndex === -1) {
    return FALLBACK_WINDOW_BUTTON_LAYOUT
  }

  const leftButtons = parseSide(raw.slice(0, colonIndex))
  const rightButtons = parseSide(raw.slice(colonIndex + 1))

  if (leftButtons.length === 0 && rightButtons.length === 0) {
    return FALLBACK_WINDOW_BUTTON_LAYOUT
  }

  if (rightButtons.length > 0) {
    return { side: 'right', buttons: rightButtons }
  }
  return { side: 'left', buttons: leftButtons }
}
