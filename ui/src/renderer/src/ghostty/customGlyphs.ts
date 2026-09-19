const BOX_ARMS: Record<number, string> = {
  0x2500: '0011', 0x2501: '0022', 0x2502: '1100', 0x2503: '2200',
  0x250c: '0101', 0x250d: '0102', 0x250e: '0201', 0x250f: '0202',
  0x2510: '0110', 0x2511: '0120', 0x2512: '0210', 0x2513: '0220',
  0x2514: '1001', 0x2515: '1002', 0x2516: '2001', 0x2517: '2002',
  0x2518: '1010', 0x2519: '1020', 0x251a: '2010', 0x251b: '2020',
  0x251c: '1101', 0x251d: '1102', 0x251e: '2101', 0x251f: '1201',
  0x2520: '2201', 0x2521: '2102', 0x2522: '1202', 0x2523: '2202',
  0x2524: '1110', 0x2525: '1120', 0x2526: '2110', 0x2527: '1210',
  0x2528: '2210', 0x2529: '2120', 0x252a: '1220', 0x252b: '2220',
  0x252c: '0111', 0x252d: '0121', 0x252e: '0112', 0x252f: '0122',
  0x2530: '0211', 0x2531: '0221', 0x2532: '0212', 0x2533: '0222',
  0x2534: '1011', 0x2535: '1021', 0x2536: '1012', 0x2537: '1022',
  0x2538: '2011', 0x2539: '2021', 0x253a: '2012', 0x253b: '2022',
  0x253c: '1111', 0x253d: '1121', 0x253e: '1112', 0x253f: '1122',
  0x2540: '2111', 0x2541: '1211', 0x2542: '2211', 0x2543: '2121',
  0x2544: '2112', 0x2545: '1221', 0x2546: '1212', 0x2547: '2122',
  0x2548: '1222', 0x2549: '2221', 0x254a: '2212', 0x254b: '2222',
  0x2550: '0033', 0x2551: '3300',
  0x2552: '0103', 0x2553: '0301', 0x2554: '0303',
  0x2555: '0130', 0x2556: '0310', 0x2557: '0330',
  0x2558: '1003', 0x2559: '3001', 0x255a: '3003',
  0x255b: '1030', 0x255c: '3010', 0x255d: '3030',
  0x255e: '1103', 0x255f: '3301', 0x2560: '3303',
  0x2561: '1130', 0x2562: '3310', 0x2563: '3330',
  0x2564: '0133', 0x2565: '0311', 0x2566: '0333',
  0x2567: '1033', 0x2568: '3011', 0x2569: '3033',
  0x256a: '1133', 0x256b: '3311', 0x256c: '3333',
  0x2574: '0010', 0x2575: '1000', 0x2576: '0001', 0x2577: '0100',
  0x2578: '0020', 0x2579: '2000', 0x257a: '0002', 0x257b: '0200',
  0x257c: '0012', 0x257d: '1200', 0x257e: '0021', 0x257f: '2100',
}

const BOX_DASHED: Record<number, [number, boolean, boolean]> = {
  0x2504: [3, false, false], 0x2505: [3, true, false],
  0x2506: [3, false, true], 0x2507: [3, true, true],
  0x2508: [4, false, false], 0x2509: [4, true, false],
  0x250a: [4, false, true], 0x250b: [4, true, true],
  0x254c: [2, false, false], 0x254d: [2, true, false],
  0x254e: [2, false, true], 0x254f: [2, true, true],
}

const BOX_ARCS: Record<number, 'dr' | 'dl' | 'ul' | 'ur'> = {
  0x256d: 'dr', 0x256e: 'dl', 0x256f: 'ul', 0x2570: 'ur',
}

const QUADRANTS: Record<number, number> = {
  0x2596: 0b0100, 0x2597: 0b1000, 0x2598: 0b0001, 0x2599: 0b1101,
  0x259a: 0b1001, 0x259b: 0b0111, 0x259c: 0b1011, 0x259d: 0b0010,
  0x259e: 0b0110, 0x259f: 0b1110,
}

export function isCustomGlyph(text: string): boolean {
  if (text.length !== 1) return false
  const code = text.charCodeAt(0)
  return code >= 0x2500 && code <= 0x259f
}

function lightWidth(w: number, h: number): number {
  return Math.max(1, Math.round(Math.min(w, h) / 8))
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function armRect(
  dir: 'u' | 'd' | 'l' | 'r',
  weightPx: number,
  x: number,
  y: number,
  w: number,
  h: number
): Rect {
  const cx = x + w / 2
  const cy = y + h / 2
  const half = weightPx / 2
  switch (dir) {
    case 'u':
      return { x: cx - half, y, w: weightPx, h: cy - y + half }
    case 'd':
      return { x: cx - half, y: cy - half, w: weightPx, h: y + h - (cy - half) }
    case 'l':
      return { x, y: cy - half, w: cx - x + half, h: weightPx }
    case 'r':
      return { x: cx - half, y: cy - half, w: x + w - (cx - half), h: weightPx }
  }
}

function fill(context: CanvasRenderingContext2D, r: Rect): void {
  context.fillRect(r.x, r.y, r.w, r.h)
}

function drawArms(
  context: CanvasRenderingContext2D,
  arms: string,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const light = lightWidth(w, h)
  const heavy = light * 3
  const gap = light * 2
  const dirs = ['u', 'd', 'l', 'r'] as const
  dirs.forEach((dir, index) => {
    const weight = arms.charCodeAt(index) - 48
    if (weight === 0) return
    if (weight === 3) {
      const base = armRect(dir, light, x, y, w, h)
      const vertical = dir === 'u' || dir === 'd'
      const offset = gap / 2 + light / 2
      fill(context, vertical ? { ...base, x: base.x - offset } : { ...base, y: base.y - offset })
      fill(context, vertical ? { ...base, x: base.x + offset } : { ...base, y: base.y + offset })
      return
    }
    fill(context, armRect(dir, weight === 2 ? heavy : light, x, y, w, h))
  })
}

function drawDashed(
  context: CanvasRenderingContext2D,
  spec: [number, boolean, boolean],
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const [segments, isHeavy, vertical] = spec
  const light = lightWidth(w, h)
  const weight = isHeavy ? light * 3 : light
  const length = vertical ? h : w
  const dash = length / (segments * 2 - 0.5)
  for (let index = 0; index < segments; index += 1) {
    const start = index * 2 * dash
    if (vertical) {
      context.fillRect(x + w / 2 - weight / 2, y + start, weight, Math.min(dash, h - start))
    } else {
      context.fillRect(x + start, y + h / 2 - weight / 2, Math.min(dash, w - start), weight)
    }
  }
}

function drawArc(
  context: CanvasRenderingContext2D,
  kind: 'dr' | 'dl' | 'ul' | 'ur',
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const light = lightWidth(w, h)
  const cx = x + w / 2
  const cy = y + h / 2
  context.save()
  context.strokeStyle = context.fillStyle
  context.lineWidth = light
  context.beginPath()
  if (kind === 'dr') {
    context.moveTo(x + w, cy)
    context.quadraticCurveTo(cx, cy, cx, y + h)
  } else if (kind === 'dl') {
    context.moveTo(x, cy)
    context.quadraticCurveTo(cx, cy, cx, y + h)
  } else if (kind === 'ul') {
    context.moveTo(x, cy)
    context.quadraticCurveTo(cx, cy, cx, y)
  } else {
    context.moveTo(x + w, cy)
    context.quadraticCurveTo(cx, cy, cx, y)
  }
  context.stroke()
  context.restore()
}

function drawDiagonal(
  context: CanvasRenderingContext2D,
  code: number,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const light = lightWidth(w, h)
  context.save()
  context.strokeStyle = context.fillStyle
  context.lineWidth = light
  context.beginPath()
  if (code === 0x2571 || code === 0x2573) {
    context.moveTo(x + w, y)
    context.lineTo(x, y + h)
  }
  if (code === 0x2572 || code === 0x2573) {
    context.moveTo(x, y)
    context.lineTo(x + w, y + h)
  }
  context.stroke()
  context.restore()
}

function drawBlock(
  context: CanvasRenderingContext2D,
  code: number,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const midY = Math.round(h / 2)
  const midX = Math.round(w / 2)
  if (code === 0x2588) {
    context.fillRect(x, y, w, h)
    return true
  }
  if (code === 0x2580) {
    context.fillRect(x, y, w, midY)
    return true
  }
  if (code >= 0x2581 && code <= 0x2587) {
    const eighths = code - 0x2580
    const filled = Math.round((h * eighths) / 8)
    context.fillRect(x, y + h - filled, w, filled)
    return true
  }
  if (code >= 0x2589 && code <= 0x258f) {
    const eighths = 8 - (code - 0x2588)
    context.fillRect(x, y, Math.round((w * eighths) / 8), h)
    return true
  }
  if (code === 0x2590) {
    context.fillRect(x + midX, y, w - midX, h)
    return true
  }
  if (code >= 0x2591 && code <= 0x2593) {
    context.save()
    context.globalAlpha = [0.25, 0.5, 0.75][code - 0x2591]!
    context.fillRect(x, y, w, h)
    context.restore()
    return true
  }
  if (code === 0x2594) {
    context.fillRect(x, y, w, Math.max(1, Math.round(h / 8)))
    return true
  }
  if (code === 0x2595) {
    const eighth = Math.max(1, Math.round(w / 8))
    context.fillRect(x + w - eighth, y, eighth, h)
    return true
  }
  const quadrants = QUADRANTS[code]
  if (quadrants !== undefined) {
    if (quadrants & 0b0001) context.fillRect(x, y, midX, midY)
    if (quadrants & 0b0010) context.fillRect(x + midX, y, w - midX, midY)
    if (quadrants & 0b0100) context.fillRect(x, y + midY, midX, h - midY)
    if (quadrants & 0b1000) context.fillRect(x + midX, y + midY, w - midX, h - midY)
    return true
  }
  return false
}

export function drawCustomGlyph(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const code = text.charCodeAt(0)
  const arms = BOX_ARMS[code]
  if (arms !== undefined) {
    drawArms(context, arms, x, y, w, h)
    return true
  }
  const dashed = BOX_DASHED[code]
  if (dashed !== undefined) {
    drawDashed(context, dashed, x, y, w, h)
    return true
  }
  const arc = BOX_ARCS[code]
  if (arc !== undefined) {
    drawArc(context, arc, x, y, w, h)
    return true
  }
  if (code >= 0x2571 && code <= 0x2573) {
    drawDiagonal(context, code, x, y, w, h)
    return true
  }
  return drawBlock(context, code, x, y, w, h)
}
