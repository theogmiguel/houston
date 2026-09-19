// Evaluated fresh per call and STATELESS by hard requirement: WebKitGTK hands every
// `evaluate_javascript` call a fresh ephemeral world even under the same world name,
// so refs must live on the Rust side and be re-resolved against the live document.
(() => {
  const MAX_ELEMENTS = 500
  const MAX_TEXT = 300

  const clamp = (s) => {
    if (typeof s !== 'string') return ''
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t
  }

  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[role="combobox"],[role="textbox"],[role="searchbox"]'
  const STRUCTURAL = 'h1,h2,h3,h4,h5,h6,[role="heading"],nav,main,[role="navigation"],[role="main"],[role="dialog"],[role="alert"],[role="alertdialog"],form,label'

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (style.opacity === '0') return false
    if (el.closest('[aria-hidden="true"]')) return false
    return true
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio' || type === 'button') return type
      if (type === 'submit' || type === 'reset') return 'button'
      return 'textbox'
    }
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    return tag
  }

  const SKIP_TEXT_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'])

  const NAME_FROM_CONTENT = new Set([
    'heading', 'label', 'legend', 'summary', 'cell', 'columnheader', 'rowheader'
  ])

  const visibleText = (el) => {
    let out = ''
    const walk = (node) => {
      if (out.length > MAX_TEXT * 4) return
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          out += child.nodeValue
          continue
        }
        if (child.nodeType !== 1) continue
        if (SKIP_TEXT_TAGS.has(child.tagName)) continue
        if (child.getAttribute && child.getAttribute('aria-hidden') === 'true') continue
        walk(child)
      }
    }
    walk(el)
    return out
  }

  const nameOf = (el, role, kind) => {
    const labelledby = el.getAttribute('aria-labelledby')
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => visibleText(n))
      if (parts.length) return clamp(parts.join(' '))
    }
    const aria = el.getAttribute('aria-label')
    if (aria) return clamp(aria)
    if (el.labels && el.labels.length) return clamp(visibleText(el.labels[0]))
    const alt = el.getAttribute('alt')
    if (alt) return clamp(alt)
    const placeholder = el.getAttribute('placeholder')
    if (placeholder) return clamp(placeholder)
    const title = el.getAttribute('title')
    if (title) return clamp(title)
    const namedByContent = kind === 'interactive' || NAME_FROM_CONTENT.has(role)
    return namedByContent ? clamp(visibleText(el)) : ''
  }

  const stateOf = (el) => {
    const state = {}
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') state.disabled = true
    if (el.checked === true || el.getAttribute('aria-checked') === 'true') state.checked = true
    const expanded = el.getAttribute('aria-expanded')
    if (expanded != null) state.expanded = expanded === 'true'
    if (el.required === true) state.required = true
    if (el.readOnly === true) state.readonly = true
    if (document.activeElement === el) state.focused = true
    return state
  }

  const describe = (el, ref, kind = 'interactive') => {
    const rect = el.getBoundingClientRect()
    const role = roleOf(el)
    const entry = {
      ref,
      role,
      tag: el.tagName.toLowerCase(),
      name: nameOf(el, role, kind),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    }
    // Never report the contents of a password field: a snapshot is read by a model and
    // lands in its transcript. The field itself stays visible so it can still be typed into.
    if (el.value != null && typeof el.value === 'string' && el.value !== '') {
      const type = (el.getAttribute('type') || '').toLowerCase()
      entry.value = type === 'password' ? '<redacted>' : clamp(el.value)
    }
    if (el.hasAttribute('href')) entry.href = clamp(el.getAttribute('href'))
    const state = stateOf(el)
    if (Object.keys(state).length) entry.state = state
    return entry
  }

  const locatorOf = (el) => {
    const path = []
    const tags = []
    let node = el
    while (node && node !== document.documentElement) {
      const parent = node.parentElement
      if (!parent) return null
      let index = 0
      let sib = node
      while ((sib = sib.previousElementSibling)) index++
      path.push(index)
      tags.push(node.tagName.toLowerCase())
      node = parent
    }
    if (node !== document.documentElement) return null
    path.reverse()
    tags.reverse()
    return { path, tags }
  }

  const snapshot = (startSeq) => {
    let seq = typeof startSeq === 'number' && startSeq >= 0 ? startSeq : 0
    const seen = new Set()
    const elements = []
    const locators = {}
    let truncated = false

    const collect = (selector, kind) => {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue
        if (elements.length >= MAX_ELEMENTS) {
          truncated = true
          return
        }
        if (!isVisible(el)) continue
        const locator = locatorOf(el)
        if (!locator) continue
        seen.add(el)
        const ref = `e${++seq}`
        locators[ref] = locator
        const entry = describe(el, ref, kind)
        entry.kind = kind
        elements.push(entry)
      }
    }
    collect(INTERACTIVE, 'interactive')
    collect(STRUCTURAL, 'structural')

    return {
      url: document.location ? document.location.href : null,
      title: document.title || null,
      readyState: document.readyState,
      elementCount: elements.length,
      truncated,
      truncatedLimit: truncated ? MAX_ELEMENTS : undefined,
      elements,
      locators
    }
  }

  const locate = (op) => {
    const stale = () =>
      new Error(
        `the element for ref ${JSON.stringify(op.ref)} has been removed or the page has ` +
          `re-rendered since the snapshot that named it. Take a fresh browser_snapshot ` +
          `and retry with a ref from it.`
      )
    if (!Array.isArray(op.path) || !Array.isArray(op.tags) || op.path.length !== op.tags.length) {
      throw new Error(
        `internal: ref ${JSON.stringify(op.ref)} arrived with a malformed locator ` +
          `(path ${JSON.stringify(op.path)}, tags ${JSON.stringify(op.tags)})`
      )
    }
    let node = document.documentElement
    for (let i = 0; i < op.path.length; i++) {
      node = node.children[op.path[i]]
      if (!node || node.tagName.toLowerCase() !== op.tags[i]) throw stale()
    }
    return node
  }

  const describe_ = (op) => ({ ref: op.ref, element: describe(locate(op), op.ref) })

  const click = (op) => {
    const ref = op.ref
    const el = locate(op)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = el.getBoundingClientRect()
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y }
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))
    return { ref, clicked: describe(el, ref) }
  }

  // An allowlist, not `typeof el.value === 'string'`: a <button>/<select>/<progress>
  // all have a string `value`, so that test lets a "type" into them report success while
  // doing nothing the caller wanted.
  const TEXTUAL_INPUT_TYPES = new Set([
    'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time',
    'datetime-local', 'month', 'week'
  ])

  const acceptsTypedText = (el) => {
    if (el.isContentEditable) return true
    const tag = el.tagName.toLowerCase()
    if (tag === 'textarea') return true
    if (tag !== 'input') return false
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    return TEXTUAL_INPUT_TYPES.has(type)
  }

  const type = (op) => {
    const ref = op.ref
    const text = op.text
    const replace = op.replace === true
    const el = locate(op)
    el.focus()
    const editable = el.isContentEditable
    if (!acceptsTypedText(el)) {
      const tag = el.tagName.toLowerCase()
      const inputType = tag === 'input' ? ` type="${el.getAttribute('type') || 'text'}"` : ''
      throw new Error(
        `the element for ref ${JSON.stringify(ref)} is a <${tag}${inputType}>, which does not ` +
          `accept typed text. Type into a text input, a textarea, or a contenteditable ` +
          `element. To activate a <${tag}>, use browser_click instead.`
      )
    }
    if (editable) {
      if (replace) el.textContent = ''
      el.textContent = (el.textContent || '') + text
    } else {
      if (replace) el.value = ''
      el.value = (el.value || '') + text
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ref, typed: describe(el, ref) }
  }

  const reveal = (op) => {
    const el = locate(op)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    return { ref: op.ref, revealed: describe(el, op.ref) }
  }

  const hover = (op) => {
    const el = locate(op)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = el.getBoundingClientRect()
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2
    }
    el.dispatchEvent(new MouseEvent('mouseover', opts))
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }))
    el.dispatchEvent(new MouseEvent('mousemove', opts))
    return { ref: op.ref, hovered: describe(el, op.ref) }
  }

  const press = (op) => {
    const el = locate(op)
    el.focus()
    const key = op.key
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`press needs a non-empty string key, got ${JSON.stringify(key)}`)
    }
    const opts = { bubbles: true, cancelable: true, key }
    const proceeded = el.dispatchEvent(new KeyboardEvent('keydown', opts))
    let submitted = false
    if (proceeded && key === 'Enter') {
      const form = el.form || (el.closest && el.closest('form'))
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit()
        submitted = true
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key }))
    return { ref: op.ref, key, submittedForm: submitted, target: describe(el, op.ref) }
  }

  const selectOption = (op) => {
    const el = locate(op)
    if (el.tagName.toLowerCase() !== 'select') {
      throw new Error(
        `the element for ref ${JSON.stringify(op.ref)} is a <${el.tagName.toLowerCase()}>, ` +
          `not a <select>. browser_select_option only works on <select> elements — for ` +
          `anything else, use browser_click.`
      )
    }
    const wanted = op.value
    const options = Array.from(el.options)
    const match =
      options.find((o) => o.value === wanted) ||
      options.find((o) => clamp(o.textContent || '') === clamp(wanted))
    if (!match) {
      const shown = options
        .slice(0, 20)
        .map((o) => `${JSON.stringify(o.value)} (${clamp(o.textContent || '')})`)
        .join(', ')
      throw new Error(
        `no option ${JSON.stringify(wanted)} in the <select> for ref ` +
          `${JSON.stringify(op.ref)}. Available${options.length > 20 ? ' (first 20 of ' + options.length + ')' : ''}: ${shown}`
      )
    }
    el.value = match.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return {
      ref: op.ref,
      selected: { value: match.value, label: clamp(match.textContent || '') },
      element: describe(el, op.ref)
    }
  }

  const exists = (op) => {
    const body = document.body
    const visible = body ? (body.innerText != null ? body.innerText : body.textContent) || '' : ''
    return {
      found: typeof op.text === 'string' && op.text.length > 0 && visible.includes(op.text),
      readyState: document.readyState
    }
  }

  try {
    const op = __TR_TOOLS_OP__
    let result
    if (op.kind === 'snapshot') result = snapshot(op.startSeq)
    else if (op.kind === 'describe') result = describe_(op)
    else if (op.kind === 'click') result = click(op)
    else if (op.kind === 'type') result = type(op)
    else if (op.kind === 'reveal') result = reveal(op)
    else if (op.kind === 'hover') result = hover(op)
    else if (op.kind === 'press') result = press(op)
    else if (op.kind === 'selectOption') result = selectOption(op)
    else if (op.kind === 'exists') result = exists(op)
    else throw new Error(`unknown page operation ${JSON.stringify(op.kind)}`)
    return JSON.stringify({ ok: true, result })
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) })
  }
})()
