import { describe, expect, it } from 'vitest'
import { FALLBACK_WINDOW_BUTTON_LAYOUT, parseWindowButtonLayout } from './windowButtonLayout'

describe('parseWindowButtonLayout', () => {
  it('parses a GNOME layout with all three buttons left of the colon', () => {
    expect(parseWindowButtonLayout('close,minimize,maximize:')).toEqual({
      side: 'left',
      buttons: ['close', 'minimize', 'maximize'],
    })
  })

  it('parses stock GNOME: one close button, right of the colon', () => {
    expect(parseWindowButtonLayout('appmenu:close')).toEqual({
      side: 'right',
      buttons: ['close'],
    })
  })

  it('parses a KDE/Windows-like layout: three buttons, right of the colon', () => {
    expect(parseWindowButtonLayout(':minimize,maximize,close')).toEqual({
      side: 'right',
      buttons: ['minimize', 'maximize', 'close'],
    })
  })

  it('drops unknown tokens (appmenu, icon, spacer) rather than rendering them', () => {
    expect(parseWindowButtonLayout('icon,spacer:appmenu,close,minimize')).toEqual({
      side: 'right',
      buttons: ['close', 'minimize'],
    })
  })

  it('when both sides carry real buttons, the right side wins and the left is dropped', () => {
    expect(parseWindowButtonLayout('close:minimize,maximize')).toEqual({
      side: 'right',
      buttons: ['minimize', 'maximize'],
    })
  })

  it('an empty left side with a populated right side yields just the right side', () => {
    expect(parseWindowButtonLayout(':close')).toEqual({
      side: 'right',
      buttons: ['close'],
    })
  })

  it('an empty right side with a populated left side yields just the left side', () => {
    expect(parseWindowButtonLayout('minimize,maximize,close:')).toEqual({
      side: 'left',
      buttons: ['minimize', 'maximize', 'close'],
    })
  })

  it('an empty string falls back to the documented default', () => {
    expect(parseWindowButtonLayout('')).toEqual(FALLBACK_WINDOW_BUTTON_LAYOUT)
  })

  it('null/undefined (gsetting absent or unread) falls back to the documented default', () => {
    expect(parseWindowButtonLayout(null)).toEqual(FALLBACK_WINDOW_BUTTON_LAYOUT)
    expect(parseWindowButtonLayout(undefined)).toEqual(FALLBACK_WINDOW_BUTTON_LAYOUT)
  })

  it('a malformed string with no colon falls back to the documented default', () => {
    expect(parseWindowButtonLayout('close,minimize,maximize')).toEqual(
      FALLBACK_WINDOW_BUTTON_LAYOUT
    )
  })

  it('a colon with nothing but unknown tokens on both sides falls back to the documented default', () => {
    expect(parseWindowButtonLayout('icon:spacer')).toEqual(FALLBACK_WINDOW_BUTTON_LAYOUT)
  })

  it('tolerates stray whitespace around tokens', () => {
    expect(parseWindowButtonLayout(' close , minimize : maximize ')).toEqual({
      side: 'right',
      buttons: ['maximize'],
    })
  })
})
