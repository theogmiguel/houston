export interface Particle { a: string; x: string; y?: string; s?: string; c: string; d?: string; w?: string; r?: string; cls?: string }
export const FX: Record<string, () => Particle[]> = {
  snow: () => many(14, () => ({ a: 'fall', x: rnd(0, 100) + '%', s: rnd(2, 4) + 'px', c: '#f4f8ff', d: rnd(2.8, 4.6) + 's', w: -rnd(0, 4) + 's' })),
  confetti: () => many(16, () => ({ a: 'fall', x: rnd(0, 100) + '%', s: rnd(3, 5) + 'px', r: '1px', c: pick(['#3fe0ff', '#f59e0b', '#a855f7', '#22c55e', '#f43f5e']), d: rnd(2.2, 3.6) + 's', w: -rnd(0, 3) + 's' })),
  fireworks: () => many(4, k => ({ a: 'burst', cls: 'ring', x: rnd(5, 85) + '%', y: rnd(-10, 30) + 'px', s: rnd(14, 22) + 'px', c: pick(['#facc15', '#3fe0ff', '#f472b6']), d: '1.8s', w: -k * .45 + 's' })).concat(FX.confetti().slice(0, 8)),
  hearts: () => many(7, () => ({ a: 'rise', cls: 'heart', x: rnd(10, 90) + '%', y: '50px', s: rnd(6, 9) + 'px', c: pick(['#f43f5e', '#fb7185', '#ec4899']), d: rnd(2.4, 3.4) + 's', w: -rnd(0, 3) + 's' })),
  stars: () => many(8, () => ({ a: 'twinkle', cls: 'star', x: rnd(0, 100) + '%', y: rnd(-6, 40) + 'px', s: rnd(5, 8) + 'px', c: pick(['#e0e7ff', '#c7d2fe', '#fef9c3']), d: rnd(1.8, 3) + 's', w: -rnd(0, 3) + 's' })),
  bats: () => many(4, k => ({ a: 'flit', cls: 'bat', x: rnd(0, 50) + '%', y: rnd(-4, 30) + 'px', s: '11px', c: '#1f1630', d: rnd(2.6, 3.6) + 's', w: -k * .8 + 's' })),
  bunting: () => many(7, k => ({ a: 'sway', cls: 'flag', x: 6 + k * 13 + '%', y: (k % 2 ? 2 : -2) + Math.abs(k - 3) * 2 + 'px', s: '8px', c: ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#f97316', '#a855f7', '#ef4444'][k], w: -k * .3 + 's' })),
};
function rnd(a: number, b: number) { return +(a + Math.random() * (b - a)).toFixed(2); }
function pick<T>(list: T[]): T { return list[Math.floor(Math.random() * list.length)]; }
function many(n: number, f: (k: number) => Particle): Particle[] { return Array.from({ length: n }, (_, k) => f(k)); }
export function fxHtml(list: Particle[], once: boolean) {
  return list.map(p => `<i class="${p.cls || ''}" style="--a:mascot-${p.a};--x:${p.x};--y:${p.y || '0px'};--s:${p.s};--c:${p.c};--d:${p.d || '3s'};--w:${p.w || '0s'};--r:${p.r || '50%'};--n:${once ? 1 : 'infinite'}"></i>`).join('');
}

