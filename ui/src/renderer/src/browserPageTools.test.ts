// @vitest-environment jsdom

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOOLS_JS = resolve(process.cwd(), '../src-tauri/src/browser/tools.js')
if (!existsSync(TOOLS_JS)) {
  throw new Error(
    `browserPageTools.test.ts cannot find the page toolkit at ${TOOLS_JS} (resolved from ` +
      `cwd ${process.cwd()}). If src-tauri/src/browser/tools.js moved, update this path — ` +
      `silently skipping would leave the toolkit with no test at all.`
  )
}

type Envelope = { ok: boolean; result?: Record<string, unknown>; error?: string }

function runOp(op: Record<string, unknown>): Envelope {
  const source = readFileSync(TOOLS_JS, 'utf8').replace('__TR_TOOLS_OP__', JSON.stringify(op))
  const raw = (0, eval)(source) as string
  expect(typeof raw).toBe('string')
  return JSON.parse(raw) as Envelope
}

function snapshot(startSeq = 0): Envelope {
  return runOp({ kind: 'snapshot', startSeq })
}

type Locator = { path: number[]; tags: string[] }

function opFor(
  snap: Envelope,
  ref: string,
  kind: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const locators = snap.result!.locators as Record<string, Locator>
  const locator = locators[ref]
  expect(locator, `snapshot reported no locator for ${ref}`).toBeTruthy()
  return { kind, ref, path: locator.path, tags: locator.tags, ...extra }
}

type Element_ = {
  ref: string
  role: string
  tag: string
  name: string
  value?: string
  state?: Record<string, unknown>
}

function elements(env: Envelope): Element_[] {
  expect(env.ok, env.error).toBe(true)
  return env.result!.elements as Element_[]
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ) {
    const style = window.getComputedStyle(this)
    const gone = style.display === 'none'
    const box = gone ? 0 : 20
    return { x: 5, y: 7, width: box, height: box, top: 7, left: 5, right: 25, bottom: 27 } as DOMRect
  })
  Element.prototype.scrollIntoView = vi.fn()
})

describe('snapshot', () => {
  it('reports interactive elements with a ref, role and accessible name', () => {
    document.body.innerHTML = `<button id="go">Send it</button>`
    const [button] = elements(snapshot())
    expect(button.ref).toMatch(/^e\d+$/)
    expect(button.role).toBe('button')
    expect(button.name).toBe('Send it')
  })

  it('prefers aria-label over text content, matching how a screen reader names it', () => {
    document.body.innerHTML = `<button aria-label="Close dialog">×</button>`
    expect(elements(snapshot())[0].name).toBe('Close dialog')
  })

  it('never names an element after CSS or script text inside it', () => {
    document.body.innerHTML = `
      <button id="b">
        <style>.plR5qb.PhjFye .bvUkz{transition:none;opacity:0}</style>
        Estou com sorte
      </button>`
    const [el] = elements(snapshot())
    expect(el.name).toBe('Estou com sorte')
    expect(el.name).not.toContain('transition')
    expect(el.name).not.toContain('{')
  })

  it('skips script text the same way', () => {
    document.body.innerHTML = `<button><script>var x = 1;</script>Search</button>`
    expect(elements(snapshot())[0].name).toBe('Search')
  })

  it('skips aria-hidden decoration inside a control', () => {
    document.body.innerHTML = `<button><span aria-hidden="true">▶</span>Play</button>`
    expect(elements(snapshot())[0].name).toBe('Play')
  })

  it('resolves aria-labelledby without dragging style text along', () => {
    document.body.innerHTML = `
      <span id="lbl"><style>.x{color:red}</style>Delete account</span>
      <button aria-labelledby="lbl">x</button>`
    const button = elements(snapshot()).find((e) => e.role === 'button')!
    expect(button.name).toBe('Delete account')
  })

  it('does not name a landmark after everything inside it', () => {
    document.body.innerHTML = `
      <nav><a href="/a">Alpha</a><a href="/b">Beta</a><a href="/c">Gamma</a></nav>`
    const nav = elements(snapshot()).find((e) => e.tag === 'nav')!
    expect(nav.name).toBe('')
  })

  it('names a custom control from its text, whatever its tag', () => {
    document.body.innerHTML = `
      <div tabindex="0">Pesquisa Google</div>
      <span role="button" tabindex="0">Estou com sorte</span>`
    const found = elements(snapshot())
    expect(found.map((e) => e.name).sort()).toEqual(['Estou com sorte', 'Pesquisa Google'])
  })

  it('still names a landmark that labels itself', () => {
    document.body.innerHTML = `<nav aria-label="Primary"><a href="/a">Alpha</a></nav>`
    const nav = elements(snapshot()).find((e) => e.tag === 'nav')!
    expect(nav.name).toBe('Primary')
  })

  it('names an input from its associated label', () => {
    document.body.innerHTML = `<label for="e">Email address</label><input id="e" />`
    const input = elements(snapshot()).find((e) => e.role === 'textbox')!
    expect(input.name).toBe('Email address')
  })

  it('redacts a password field value but still reports the field', () => {
    document.body.innerHTML = `<input type="password" value="hunter2" aria-label="Password" />`
    const field = elements(snapshot())[0]
    expect(field.value).toBe('<redacted>')
    expect(JSON.stringify(field)).not.toContain('hunter2')
    expect(field.name).toBe('Password')
  })

  it('excludes elements the user cannot see', () => {
    document.body.innerHTML = `
      <button>Visible</button>
      <button style="display: none">Hidden</button>
      <button style="visibility: hidden">Invisible</button>
      <div aria-hidden="true"><button>Behind aria-hidden</button></div>`
    const names = elements(snapshot()).map((e) => e.name)
    expect(names).toEqual(['Visible'])
  })

  it('reports element state a model needs before acting', () => {
    document.body.innerHTML = `
      <button disabled aria-label="Off">x</button>
      <input type="checkbox" checked aria-label="Agree" />`
    const found = elements(snapshot())
    expect(found.find((e) => e.name === 'Off')!.state!.disabled).toBe(true)
    expect(found.find((e) => e.name === 'Agree')!.state!.checked).toBe(true)
  })

  it('carries the page url, title and load state', () => {
    document.title = 'A page'
    const env = snapshot()
    expect(env.result!.title).toBe('A page')
    expect(env.result!.readyState).toBeTruthy()
    expect(typeof env.result!.url).toBe('string')
  })

  it('reports truncation and the limit rather than silently dropping elements', () => {
    document.body.innerHTML = Array.from(
      { length: 520 },
      (_, i) => `<button>b${i}</button>`
    ).join('')
    const env = snapshot()
    expect(env.result!.truncated).toBe(true)
    expect(env.result!.truncatedLimit).toBe(500)
    expect((env.result!.elements as unknown[]).length).toBe(500)
  })

  it('mints a fresh ref on every snapshot so an old ref cannot silently resolve', () => {
    document.body.innerHTML = `<button>One</button>`
    const first = snapshot()
    const firstRef = elements(first)[0].ref
    const second = snapshot(first.result!.elementCount as number)
    expect(elements(second)[0].ref).not.toBe(firstRef)
  })

  it('numbers refs from the startSeq the Rust store passes in', () => {
    document.body.innerHTML = `<button>One</button>`
    expect(elements(snapshot(7))[0].ref).toBe('e8')
  })

  it('reports a locator for every element it mints, and the model payload for none', () => {
    document.body.innerHTML = `<button>One</button><a href="/x">Two</a>`
    const snap = snapshot()
    const found = elements(snap)
    const locators = snap.result!.locators as Record<string, Locator>
    for (const el of found) {
      expect(locators[el.ref], `no locator for ${el.ref}`).toBeTruthy()
      expect(locators[el.ref].path.length).toBe(locators[el.ref].tags.length)
      expect('path' in el).toBe(false)
    }
  })

  it('keeps no state on the page between calls', () => {
    document.body.innerHTML = `<button>Go</button>`
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    expect(runOp(opFor(snap, ref, 'click')).ok).toBe(true)
    expect('__trTools' in window, 'nothing may be stored on window').toBe(false)
  })
})

describe('click', () => {
  it('dispatches a real pointer sequence the page can listen for', () => {
    document.body.innerHTML = `<button>Go</button>`
    const seen: string[] = []
    const button = document.querySelector('button')!
    for (const type of ['mousedown', 'mouseup', 'click']) {
      button.addEventListener(type, () => seen.push(type))
    }
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    const env = runOp(opFor(snap, ref, 'click'))
    expect(env.ok, env.error).toBe(true)
    expect(seen).toEqual(['mousedown', 'mouseup', 'click'])
  })

  it('refuses a ref whose element the page has since removed', () => {
    document.body.innerHTML = `<button>Gone soon</button>`
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    document.body.innerHTML = ''
    const env = runOp(opFor(snap, ref, 'click'))
    expect(env.ok).toBe(false)
    expect(env.error).toContain('re-rendered')
    expect(env.error).toContain('browser_snapshot')
  })

  it('refuses to click a different element that took the old one\'s place', () => {
    document.body.innerHTML = `<button>Buy</button>`
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    document.body.innerHTML = `<a href="/somewhere-else">Buy</a>`
    const clicks: string[] = []
    document.querySelector('a')!.addEventListener('click', () => clicks.push('click'))
    const env = runOp(opFor(snap, ref, 'click'))
    expect(env.ok).toBe(false)
    expect(env.error).toContain('re-rendered')
    expect(clicks, 'the replacement element must not be clicked').toEqual([])
  })

  it('reports a malformed locator as an internal bug, not as a stale page', () => {
    document.body.innerHTML = `<button>Go</button>`
    const env = runOp({ kind: 'click', ref: 'e1', path: [0], tags: ['body', 'button'] })
    expect(env.ok).toBe(false)
    expect(env.error).toContain('internal')
  })
})

describe('type', () => {
  it('writes the value and fires the events frameworks listen for', () => {
    document.body.innerHTML = `<input aria-label="Search" />`
    const input = document.querySelector('input')!
    const fired: string[] = []
    input.addEventListener('input', () => fired.push('input'))
    input.addEventListener('change', () => fired.push('change'))

    const snap = snapshot()
    const ref = elements(snap)[0].ref
    const env = runOp(opFor(snap, ref, 'type', { text: 'hello' }))
    expect(env.ok, env.error).toBe(true)
    expect(input.value).toBe('hello')
    expect(fired).toEqual(['input', 'change'])
  })

  it('appends by default and replaces only when asked', () => {
    document.body.innerHTML = `<input aria-label="S" value="ab" />`
    const input = document.querySelector('input')!

    const first = snapshot()
    runOp(opFor(first, elements(first)[0].ref, 'type', { text: 'cd' }))
    expect(input.value).toBe('abcd')

    const second = snapshot()
    runOp(opFor(second, elements(second)[0].ref, 'type', { text: 'zz', replace: true }))
    expect(input.value).toBe('zz')
  })

  it('types into a contenteditable element', () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="Body"></div>`
    const div = document.querySelector('div')!
    Object.defineProperty(div, 'isContentEditable', { value: true })
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    const env = runOp(opFor(snap, ref, 'type', { text: 'written' }))
    expect(env.ok, env.error).toBe(true)
    expect(div.textContent).toBe('written')
  })

  it('refuses an element that holds no text, naming what it was', () => {
    document.body.innerHTML = `<button>Not a field</button>`
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    const env = runOp(opFor(snap, ref, 'type', { text: 'x' }))
    expect(env.ok).toBe(false)
    expect(env.error).toContain('button')
    expect(env.error).toContain('contenteditable')
  })
  it.each(['<select aria-label="S"><option>a</option></select>', '<progress aria-label="P" tabindex="0"></progress>'])(
    'refuses %s, which has a string value but accepts no typing',
    (html) => {
      document.body.innerHTML = html
      const snap = snapshot()
      const ref = elements(snap)[0].ref
      const env = runOp(opFor(snap, ref, 'type', { text: 'x' }))
      expect(env.ok).toBe(false)
      expect(env.error).toContain('does not accept typed text')
    }
  )

  it('refuses a checkbox, pointing at click instead', () => {
    document.body.innerHTML = `<input type="checkbox" aria-label="Agree" />`
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    const env = runOp(opFor(snap, ref, 'type', { text: 'x' }))
    expect(env.ok).toBe(false)
    expect(env.error).toContain('browser_click')
  })
})

describe('the envelope', () => {
  it('reports an unknown operation as data, never as an evaluation failure', () => {
    const env = runOp({ kind: 'not-a-real-op' })
    expect(env.ok).toBe(false)
    expect(env.error).toContain('not-a-real-op')
  })
})

describe('describe', () => {
  it('reports what a ref points at without touching it', () => {
    document.body.innerHTML = `<button>Delete account</button>`
    const clicks: string[] = []
    document.querySelector('button')!.addEventListener('click', () => clicks.push('click'))

    const snap = snapshot()
    const ref = elements(snap)[0].ref
    const env = runOp(opFor(snap, ref, 'describe'))

    expect(env.ok, env.error).toBe(true)
    const el = (env.result as { element: Element_ }).element
    expect(el.name).toBe('Delete account')
    expect(el.role).toBe('button')
    expect(clicks, 'describe must never act on the element').toEqual([])
  })

  it('carries the box the confirmation gate outlines the target with', () => {
    document.body.innerHTML = `<button>Go</button>`
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    const env = runOp(opFor(snap, ref, 'describe'))
    const rect = (env.result as { element: { rect: Record<string, number> } }).element.rect
    expect(rect).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
    expect(rect.width).toBeGreaterThan(0)
  })

  it('refuses a ref whose element is gone, so the gate never outlines nothing', () => {
    document.body.innerHTML = `<button>Bye</button>`
    const snap = snapshot()
    const ref = elements(snap)[0].ref
    document.body.innerHTML = ''
    const env = runOp(opFor(snap, ref, 'describe'))
    expect(env.ok).toBe(false)
    expect(env.error).toContain('re-rendered')
  })
})

describe('hover', () => {
  it('fires the JS hover sequence a menu or tooltip listens for', () => {
    document.body.innerHTML = `<button>Menu</button>`
    const seen: string[] = []
    const button = document.querySelector('button')!
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      button.addEventListener(type, () => seen.push(type))
    }
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'hover'))
    expect(env.ok, env.error).toBe(true)
    expect(seen).toEqual(['mouseover', 'mouseenter', 'mousemove'])
  })
})

describe('press', () => {
  it('fires keydown and keyup with the requested key', () => {
    document.body.innerHTML = `<input aria-label="Search" />`
    const input = document.querySelector('input')!
    const seen: string[] = []
    input.addEventListener('keydown', (e) => seen.push(`down:${e.key}`))
    input.addEventListener('keyup', (e) => seen.push(`up:${e.key}`))
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'press', { key: 'ArrowDown' }))
    expect(env.ok, env.error).toBe(true)
    expect(seen).toEqual(['down:ArrowDown', 'up:ArrowDown'])
  })

  it('submits the enclosing form on Enter, like the real default action', () => {
    document.body.innerHTML = `<form><input aria-label="Q" /></form>`
    const form = document.querySelector('form')!
    const submits: string[] = []
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      submits.push('submit')
    })
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'press', { key: 'Enter' }))
    expect(env.ok, env.error).toBe(true)
    expect(submits).toEqual(['submit'])
    expect((env.result as { submittedForm: boolean }).submittedForm).toBe(true)
  })

  it('does not submit when the page handled the key itself', () => {
    document.body.innerHTML = `<form><input aria-label="Q" /></form>`
    const input = document.querySelector('input')!
    input.addEventListener('keydown', (e) => e.preventDefault())
    const submits: string[] = []
    document.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault()
      submits.push('submit')
    })
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'press', { key: 'Enter' }))
    expect(env.ok, env.error).toBe(true)
    expect(submits).toEqual([])
  })
})

describe('selectOption', () => {
  const SELECT = `
    <select aria-label="Country">
      <option value="br">Brazil</option>
      <option value="pt">Portugal</option>
    </select>`

  it('chooses by value and fires input/change', () => {
    document.body.innerHTML = SELECT
    const select = document.querySelector('select')!
    const fired: string[] = []
    select.addEventListener('input', () => fired.push('input'))
    select.addEventListener('change', () => fired.push('change'))
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'selectOption', { value: 'pt' }))
    expect(env.ok, env.error).toBe(true)
    expect(select.value).toBe('pt')
    expect(fired).toEqual(['input', 'change'])
  })

  it('falls back to the visible label when no value matches', () => {
    document.body.innerHTML = SELECT
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'selectOption', { value: 'Portugal' }))
    expect(env.ok, env.error).toBe(true)
    expect(document.querySelector('select')!.value).toBe('pt')
  })

  it('refuses an unknown option by listing what is available', () => {
    document.body.innerHTML = SELECT
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'selectOption', { value: 'xx' }))
    expect(env.ok).toBe(false)
    expect(env.error).toContain('"xx"')
    expect(env.error).toContain('Brazil')
    expect(env.error).toContain('"pt"')
  })

  it('refuses a non-select element, pointing at click instead', () => {
    document.body.innerHTML = `<button>Not a select</button>`
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'selectOption', { value: 'x' }))
    expect(env.ok).toBe(false)
    expect(env.error).toContain('<button>')
    expect(env.error).toContain('browser_click')
  })
})

describe('exists', () => {
  it('reports whether the text is on the page, for the Rust-side wait loop', () => {
    document.body.innerHTML = `<p>Payment confirmed</p>`
    const found = runOp({ kind: 'exists', text: 'Payment confirmed' })
    expect(found.ok).toBe(true)
    expect(found.result!.found).toBe(true)
    const missing = runOp({ kind: 'exists', text: 'Payment failed' })
    expect(missing.result!.found).toBe(false)
  })
})

describe('reveal', () => {
  it('scrolls the target to center and reports its post-scroll box', () => {
    document.body.innerHTML = `<button>Deep link</button>`
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'reveal'))
    expect(env.ok, env.error).toBe(true)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'center'
    })
    expect((env.result as { revealed: { name: string } }).revealed.name).toBe('Deep link')
  })

  it('describe still never scrolls', () => {
    document.body.innerHTML = `<button>Quiet</button>`
    const snap = snapshot()
    const env = runOp(opFor(snap, elements(snap)[0].ref, 'describe'))
    expect(env.ok, env.error).toBe(true)
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })
})
