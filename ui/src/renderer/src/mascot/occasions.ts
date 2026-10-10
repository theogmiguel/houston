import type { Accessory } from '../components/ui/mascotAccessories'
export interface Occasion { id: string; name: string; rule: string; outfit: string; ranges: (year: number) => Date[][]; hat?: Accessory; face?: Accessory; hand?: Accessory; body?: Accessory; fx?: string; line: (date: Date) => string }
export function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function occasions(INSTALL: Date): Occasion[] { return [
  { id: 'anniv', name: 'Install anniversary', rule: 'Install day, every year after the first', outfit: 'Party hat, confetti',
    ranges: (y: number) => y > INSTALL.getFullYear() ? [[new Date(y, INSTALL.getMonth(), INSTALL.getDate())]] : [], hat: 'party', fx: 'confetti',
    line: (d: Date) => { const n = d.getFullYear() - INSTALL.getFullYear(); return `${n} ${n === 1 ? 'year' : 'years'} together!`; } },
  { id: 'reveillon', name: 'New Year (Réveillon)', rule: 'Dec 31 and Jan 1', outfit: 'Party hat, fireworks',
    ranges: (y: number) => [[new Date(y - 1, 11, 31), new Date(y, 0, 1)], [new Date(y, 11, 31), new Date(y + 1, 0, 1)]], hat: 'party', fx: 'fireworks', line: () => 'Happy New Year!' },
  { id: 'natal', name: 'Christmas', rule: 'Dec 24 and 25', outfit: 'Santa hat, snow',
    ranges: (y: number) => [[new Date(y, 11, 24), new Date(y, 11, 25)]], hat: 'santa', fx: 'snow', line: () => 'Merry Christmas!' },
  { id: 'carnaval', name: 'Carnival', rule: 'Saturday to Tuesday before Ash Wednesday (Easter − 50 to − 47 days)', outfit: 'Feathered mask, confetti',
    ranges: (y: number) => { const e = easter(y); return [[addDays(e, -50), addDays(e, -47)]]; }, face: 'mask', fx: 'confetti', line: () => 'It\'s Carnival!' },
  { id: 'pascoa', name: 'Easter', rule: 'Good Friday to Easter Sunday (Gregorian computus)', outfit: 'Bunny ears, painted egg',
    ranges: (y: number) => { const e = easter(y); return [[addDays(e, -2), e]]; }, hat: 'bunny', hand: 'egg', line: () => 'Happy Easter!' },
  { id: 'namorados', name: 'Dia dos Namorados', rule: 'June 12', outfit: 'Heart, floating hearts',
    ranges: (y: number) => [[new Date(y, 5, 12)]], hand: 'heart', fx: 'hearts', line: () => 'Love is in the orbit.' },
  { id: 'criancas', name: 'Children\'s Day', rule: 'October 12', outfit: 'Propeller cap, confetti',
    ranges: (y: number) => [[new Date(y, 9, 12)]], hat: 'propeller', fx: 'confetti', line: () => 'Happy Children\'s Day!' },
  { id: 'halloween', name: 'Halloween', rule: 'October 31', outfit: 'Witch hat, pumpkin, bats',
    ranges: (y: number) => [[new Date(y, 9, 31)]], hat: 'witch', body: 'pumpkin', fx: 'bats', line: () => 'Boo!' },
  { id: 'junina', name: 'Festa Junina', rule: 'June 1 to 30 (São João on June 24)', outfit: 'Straw hat, bunting',
    ranges: (y: number) => [[new Date(y, 5, 1), new Date(y, 5, 30)]], hat: 'straw', fx: 'bunting', line: () => 'Arraiá time!' },
 ]; }

export function occasionOn(date: Date, install: Date): Occasion | undefined {
  const key = ymd(date)
  return occasions(install).find((o) => o.ranges(date.getFullYear()).some(([a, b = a]) => ymd(a) <= key && key <= ymd(b)))
}
