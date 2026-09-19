import { act } from 'react'

export function selectTrigger(root: ParentNode, testId: string): HTMLButtonElement {
  const el = root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`Select trigger not found: [data-testid="${testId}"]`)
  return el
}

export function selectValue(root: ParentNode, testId: string): string {
  return selectTrigger(root, testId).textContent?.trim() ?? ''
}

export function openSelect(root: ParentNode, testId: string): HTMLElement[] {
  const trigger = selectTrigger(root, testId)
  if (trigger.dataset.open === undefined) {
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
  }
  const listboxId = trigger.getAttribute('aria-controls')
  if (!listboxId) throw new Error(`Select did not open: [data-testid="${testId}"]`)
  const menu = trigger.ownerDocument.getElementById(listboxId)
  if (!menu) throw new Error(`Select menu not rendered: [data-testid="${testId}"]`)
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]'))
}

export function selectOptionLabels(root: ParentNode, testId: string): string[] {
  const labels = openSelect(root, testId).map((o) => o.textContent?.trim() ?? '')
  closeSelect(root, testId)
  return labels
}

export function selectOptionValues(root: ParentNode, testId: string): string[] {
  const values = openSelect(root, testId).map((o) => o.dataset.value ?? '')
  closeSelect(root, testId)
  return values
}

export function pickOption(root: ParentNode, testId: string, value: string): void {
  const rows = openSelect(root, testId)
  const row = rows.find((r) => r.dataset.value === value)
  if (!row) {
    const have = rows.map((r) => r.dataset.value ?? '').join(', ')
    throw new Error(`Select "${testId}" has no option with value "${value}" — options are: ${have}`)
  }
  act(() => {
    row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  })
}

export function closeSelect(root: ParentNode, testId: string): void {
  const trigger = selectTrigger(root, testId)
  if (trigger.dataset.open === undefined) return
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}
