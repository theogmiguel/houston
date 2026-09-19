function topLevelBlocks(css: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
      continue
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < css.length; i++) {
        if (css[i] === '\\') i++
        else if (css[i] === ch) break
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        out.push(css.slice(start, i + 1))
        start = i + 1
      }
    }
  }
  const tail = css.slice(start)
  if (tail.trim()) out.push(tail)
  return out
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

function bodyBraceIndex(block: string): number {
  for (let i = 0; i < block.length; i++) {
    if (block[i] === '/' && block[i + 1] === '*') {
      const end = block.indexOf('*/', i + 2)
      i = end === -1 ? block.length : end + 1
      continue
    }
    if (block[i] === '{') return i
  }
  return -1
}

function prefixSelector(sel: string, scope: string): string {
  return sel
    .split(',')
    .map((s) => {
      const t = s.trim()
      if (!t) return t
      if (/^(html|body|:root)\b/.test(t)) return t
      return `${scope} ${t}`
    })
    .join(', ')
}

export function injectOldSheet(css: string, scope = ":where([data-side='old'])"): void {
  const scoped = scopeOldCss(css, scope)
  const style = document.createElement('style')
  style.textContent = scoped
  document.head.appendChild(style)
  const expected = topLevelBlocks(scoped).filter((b) => bodyBraceIndex(b) !== -1).length
  const got = style.sheet ? style.sheet.cssRules.length : 0
  if (got !== expected) {
    throw new Error(
      `old sheet: browser parsed ${got} of ${expected} top-level rules — ` +
        `${expected - got} were dropped as invalid. The old side is NOT what shipped; ` +
        `every comparison against it is meaningless until this is fixed.`
    )
  }
}

export function scopeOldCss(css: string, scope = ":where([data-side='old'])"): string {
  return topLevelBlocks(css)
    .map((block) => {
      const brace = bodyBraceIndex(block)
      if (brace === -1) return block
      const head = stripComments(block.slice(0, brace)).trim()
      if (/^@(keyframes|font-face|property)\b/.test(head)) return block
      if (head.startsWith('@')) {
        if (head.includes(';')) {
          throw new Error(
            `old sheet: statement at-rule glued to a block head — ${JSON.stringify(head.slice(0, 120))}. ` +
              `Expected every at-rule in this sheet to be block form; scoping it would need splitting the ` +
              `statement off the head first.`
          )
        }
        const body = block.slice(brace + 1, block.lastIndexOf('}'))
        return `${head} {\n${scopeOldCss(body, scope)}\n}`
      }
      return `${prefixSelector(head, scope)} ${block.slice(brace)}`
    })
    .join('\n')
}
