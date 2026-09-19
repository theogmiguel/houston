;(() => {
  const SEEN = { last: null }

  const describe = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      testid: el.getAttribute('data-testid'),
      label: el.getAttribute('aria-label'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      disabled: el.disabled === true,
      topmostAtCentre: (() => {
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        if (!hit) return 'none'
        if (hit === el || el.contains(hit)) return 'self'
        return hit.tagName + (hit.getAttribute('data-testid') ? `[${hit.getAttribute('data-testid')}]` : '')
      })()
    }
  }

  const sample = () => {
    const picker = document.querySelector('[data-testid^="browser-picker-toggle"]')
    const fullscreen = document.querySelector('[aria-label^="Expand browser"], [aria-label^="Exit full screen"]')
    const capture = document.querySelector('[data-testid="browser-capture"]')
    const row = capture?.parentElement ?? fullscreen?.parentElement ?? null
    const tabsPill = row ? row.querySelector('[aria-haspopup="menu"]') : null
    if (!row) return { toolbarFound: false, pickerCount: document.querySelectorAll('[data-testid^="browser-picker-toggle"]').length }

    return {
      toolbarFound: true,
      pickerCount: document.querySelectorAll('[data-testid^="browser-picker-toggle"]').length,
      picker: describe(picker),
      fullscreen: describe(fullscreen),
      tabsPill: describe(tabsPill),
      row: row
        ? {
            rect: (() => {
              const r = row.getBoundingClientRect()
              return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
            })(),
            overflow: getComputedStyle(row).overflow,
            childCount: row.children.length,
            children: [...row.children].map(
              (c) => c.getAttribute('data-testid') || c.getAttribute('aria-label') || c.tagName
            )
          }
        : null
    }
  }

  const report = (payload) => {
    try {
      window.__TAURI_INTERNALS__.invoke('system_log_debug', {
        source: 'dom-probe',
        message: 'picker-toggle',
        payload
      })
    } catch (err) {
      console.error('dom-probe: report failed', err)
    }
  }

  let opened = false
  const openBrowserTab = () => {
    if (opened) return
    const btn = document.querySelector('button[data-tab="browser"]')
    if (!btn) return
    opened = true
    btn.click()
    report({ note: 'clicked the Browser tab to make the toolbar exist' })
  }

  const SEED_FLAG = 'tr-dom-probe-seeded'
  const TABS_KEY = 'tr-browser-tabs.v1'
  const seedNavigatedTab = () => {
    if (localStorage.getItem(SEED_FLAG)) return
    const existing = localStorage.getItem(TABS_KEY)
    if (existing !== null) {
      localStorage.setItem(SEED_FLAG, 'declined')
      report({
        note: 'declined to seed: this channel already has saved browser tabs, and overwriting them would destroy real state',
        existingBytes: existing.length
      })
      return
    }
    localStorage.setItem(SEED_FLAG, '1')
    localStorage.setItem(
      TABS_KEY,
      JSON.stringify({ tabs: [{ id: 1, url: 'https://example.com/' }], activeTabId: 1 })
    )
    report({ note: 'seeded a navigated tab into an empty store; reloading into it' })
    location.reload()
  }

  setInterval(() => {
    openBrowserTab()
    const s = sample()
    if (!s) return
    if (s.toolbarFound && s.row.rect.w > 0) seedNavigatedTab()
    const key = JSON.stringify(s)
    if (key === SEEN.last) return
    SEEN.last = key
    report(s)
  }, 1500)
})()
