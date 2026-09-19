// MUTATION FIXTURE: 23 decision paths against a ceiling of 20, which
// check-complexity.mjs must refuse. Never imported.
export function Bad(p: Record<string, boolean>): string {
  let s = ''
  if (p.a && p.b) s += '1'
  if (p.c && p.d) s += '2'
  if (p.e && p.f) s += '3'
  if (p.g && p.h) s += '4'
  if (p.i && p.j) s += '5'
  if (p.k && p.l) s += '6'
  if (p.m && p.n) s += '7'
  if (p.o && p.p) s += '8'
  if (p.q && p.r) s += '9'
  if (p.s && p.t) s += '10'
  if (p.u && p.v) s += '11'
  return s
}
