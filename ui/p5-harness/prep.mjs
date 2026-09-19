const SETTLE_MS = 2000
const rectOf = async (page, query, fx = 0.5, fy = 0.5) => {
  const deadline = Date.now() + SETTLE_MS
  for (;;) {
    const r = await page.evaluate(
      ({ q, x, y }) => {
        const el = document.querySelector(`[data-stage] ${q}`)
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: Math.round(b.left + b.width * x), y: Math.round(b.top + b.height * y) }
      },
      { q: query, x: fx, y: fy }
    )
    if (r) return r
    if (Date.now() >= deadline) return null
    await page.waitForTimeout(20)
  }
}

export const prep = async (page, steps) => {
  await page.mouse.up().catch(() => {})
  const onStage = (sel) => page.evaluate((s) => !!document.querySelector(`[data-stage] ${s}`), sel)
  for (const step of steps) {
    if (step.ensure) {
      const { ensure, ...action } = step
      if (!(await onStage(ensure))) {
        const r = await prep(page, [action])
        if (!r.ok) return r
        await page.waitForTimeout(60)
      }
      if (!(await onStage(ensure))) {
        return {
          ok: false,
          why: `ensure: no element matches [data-stage] ${ensure} after running ${JSON.stringify(action)} — expected the step to leave exactly that surface on the stage`
        }
      }
      continue
    }
    if (step.call) {
      const r = await page.evaluate((name) => {
        const w = (window)
        if (typeof w.__harnessCall !== 'function') {
          return { ok: false, why: `call: no window.__harnessCall hook installed (wanted "${name}")` }
        }
        try {
          w.__harnessCall(name)
        } catch (e) {
          return { ok: false, why: `call "${name}" threw: ${e instanceof Error ? e.message : e}` }
        }
        return { ok: true }
      }, step.call)
      if (!r.ok) return r
      await page.waitForTimeout(60)
      continue
    }
    if (step.dragTo || step.toQuery) {
      const box = async (name) =>
        page.evaluate((n) => {
          const names = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), (el.textContent || '').trim()].filter(Boolean)
          const hits = [...document.querySelectorAll('[data-stage] [data-ws-idx], [data-stage] .pane-head, [data-stage] [role="separator"]')].filter((el) =>
            names(el).some((x) => x === n || x.includes(n))
          )
          if (!hits.length) return null
          const r = hits[0].getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        }, name)
      const from = await box(step.name)
      const to = step.toQuery
        ? await rectOf(page, step.toQuery, step.toFrac?.x ?? 0.5, step.toFrac?.y ?? 0.5)
        : await box(step.dragTo)
      if (!from || !to)
        return { ok: false, why: `pointer drag: no row for ${!from ? step.name : step.toQuery || step.dragTo}` }
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x, from.y + 12)
      await page.mouse.move(to.x, to.y)
      await page.waitForTimeout(60)
      continue
    }
    if (step.query && step.focusAndReplace !== undefined) {
      const rect = await rectOf(page, step.query)
      if (!rect)
        return {
          ok: false,
          why: `focusAndReplace: no element matched query ${JSON.stringify(step.query)} after ${SETTLE_MS}ms`
        }
      await page.mouse.click(rect.x, rect.y)
      await page.keyboard.press('Control+a')
      await page.keyboard.type(step.focusAndReplace)
      await page.waitForTimeout(60)
      continue
    }
    if (step.key) {
      await page.keyboard.press(step.key)
      await page.waitForTimeout(60)
      continue
    }
    if (step.wait) {
      await page.waitForTimeout(step.wait)
      continue
    }
    if (step.query && step.activate) {
      const rect = await rectOf(page, step.query)
      if (!rect)
        return {
          ok: false,
          why: `activate: no element matched query ${JSON.stringify(step.query)} after ${SETTLE_MS}ms`
        }
      await page.mouse.move(rect.x, rect.y)
      await page.mouse.down()
      await page.mouse.up()
      await page.waitForTimeout(60)
      continue
    }
    if (step.query && step.focus) {
      const loc = page.locator(`[data-stage] ${step.query}`).first()
      try {
        await loc.waitFor({ state: 'attached', timeout: SETTLE_MS })
      } catch {
        return {
          ok: false,
          why: `focus: no element matched query ${JSON.stringify(step.query)} after ${SETTLE_MS}ms`
        }
      }
      await loc.focus()
      await page.waitForTimeout(60)
      continue
    }
    if (step.hover) {
      const hoverDeadline = Date.now() + SETTLE_MS
      let rect = null
      do {
      rect = await page.evaluate((n) => {
        const names = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), (el.textContent || '').trim()].filter(Boolean)
        const depth = (el) => {
          let d = 0
          for (let e = el; e; e = e.parentElement) d++
          return d
        }
        const candidates = [...document.querySelectorAll('[data-stage] .ctx-item, [data-stage] button, [data-stage] [role="button"], [data-stage] .pane-head')]
        const scored = candidates
          .map((el) => {
            const nm = names(el)
            const len = (el.textContent || '').length
            if (nm.some((x) => x === n)) return { el, rank: 0, len, depth: depth(el) }
            if (nm.some((x) => x.includes(n))) return { el, rank: 1, len, depth: depth(el) }
            return null
          })
          .filter(Boolean)
          .sort((a, b) => a.rank - b.rank || a.len - b.len || b.depth - a.depth)
        if (!scored.length) return null
        const r = scored[0].el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      }, step.name)
        if (!rect && Date.now() < hoverDeadline) await page.waitForTimeout(20)
      } while (!rect && Date.now() < hoverDeadline)
      if (!rect)
        return { ok: false, why: `hover: no element matched ${JSON.stringify(step)} after ${SETTLE_MS}ms` }
      await page.mouse.move(rect.x, rect.y)
      await page.waitForTimeout(60)
      continue
    }
    const r = await inPage(page, [step])
    if (!r.ok) return r
  }
  return { ok: true }
}

const inPage = (page, steps) =>
  page.evaluate(async (steps) => {
    const names = (el) =>
      [el.getAttribute('aria-label'), el.getAttribute('title'), (el.textContent || '').trim()].filter(Boolean)
    const SETTLE_MS = 2000
    // `performance.now()`, not `Date.now()`: the page clock is frozen to a fixed
    // instant, so a Date-based deadline would never advance and this would spin
    // forever on a target that is genuinely absent.
    const settle = async (get) => {
      const deadline = performance.now() + SETTLE_MS
      for (;;) {
        const hit = get()
        if (hit) return hit
        if (performance.now() >= deadline) return null
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    for (const step of steps) {
      if (step.query) {
        const match = await settle(() => document.querySelector(`[data-stage] ${step.query}`))
        if (!match) return { ok: false, why: `query: no element matched ${JSON.stringify(step)} after ${SETTLE_MS}ms` }
        if (step.dragEnter) {
          const dt = new DataTransfer()
          dt.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }))
          match.dispatchEvent(
            new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt })
          )
        } else if (step.dragOver) {
          const dt = new DataTransfer()
          match.dispatchEvent(
            new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
          )
        } else {
          return { ok: false, why: `query step ${JSON.stringify(step)} names no recognised action` }
        }
        continue
      }
      const role = step.role || (step.dragOver ? '*' : 'button')
      const sel =
        role === 'button'
          ? '[data-stage] button, [data-stage] [role="button"]'
          : `[data-stage] ${role}`
      const pick = () => {
      const candidates = [...document.querySelectorAll(sel)]
      const depth = (el) => {
        let d = 0
        for (let e = el; e; e = e.parentElement) d++
        return d
      }
      const scored = candidates
        .map((el) => {
          const n = names(el)
          const len = (el.textContent || '').length
          if (n.some((x) => x === step.name)) return { el, rank: 0, len, depth: depth(el) }
          if (n.some((x) => x.includes(step.name))) return { el, rank: 1, len, depth: depth(el) }
          return null
        })
        .filter(Boolean)
        .sort((a, b) => a.rank - b.rank || a.len - b.len || b.depth - a.depth)
      return scored.length ? scored[0].el : null
      }
      const match = await settle(pick)
      if (!match) return { ok: false, why: `no element matched ${JSON.stringify(step)} after ${SETTLE_MS}ms` }
      if (match.disabled) {
        const deadline = performance.now() + 500
        while (match.disabled && performance.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25))
        }
        if (match.disabled) return { ok: false, why: `${JSON.stringify(step)} target is disabled` }
      }
      if (step.dragOver) {
        const dt = new DataTransfer()
        match.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      } else if (step.contextMenu) {
        const r = match.getBoundingClientRect()
        match.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + r.height / 2)
          })
        )
      } else if (step.type === undefined) {
        match.click()
      } else {
        const proto = Object.getPrototypeOf(match)
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(match, step.type)
        match.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return { ok: true }
  }, steps)
