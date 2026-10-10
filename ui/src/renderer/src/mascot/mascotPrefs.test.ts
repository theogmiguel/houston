import { expect, it } from 'vitest'
import { DEFAULT_PREFS, readMascotPrefs } from './mascotPrefs'
it('invalid stored values fall back to defaults',()=>expect(readMascotPrefs({getItem:()=> 'invalid'})).toEqual(DEFAULT_PREFS))
it('honors valid stored choices',()=>expect(readMascotPrefs({getItem:key=>({'tr-mascot-enabled':'0','tr-mascot-style':'pixel','tr-mascot-colors':'aurora'}[key])??null})).toMatchObject({enabled:false,style:'pixel',colors:'aurora'}))
