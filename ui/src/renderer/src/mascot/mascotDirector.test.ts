import { describe, expect, it } from 'vitest'
import { mascotDirector, emptyLedger, BREAK_MS, SPEECH_GAP_MS, type DirectorInput, type Moment } from './mascotDirector'
import { DEFAULT_PREFS } from './mascotPrefs'
const now=new Date(2026,11,25,8).getTime()
function input(p:Partial<DirectorInput>={}):DirectorInput {return {now,prefs:DEFAULT_PREFS,focus:true,lastInputAt:now,lastTypingAt:now-6000,theme:'graphite',sleeping:false,playing:null,disco:false,gameOpen:false,active:null,queue:[],ledger:emptyLedger(now),continuousInputAt:now,lastPlayAt:now,...p}}
const m=(priority:Moment['priority'],id='test'):Moment=>({id,priority,mood:'wave',line:'Hi',until:now+3000,expires:now+10000})
describe('mascot director',()=>{
  it('P0 preempts every lower priority regardless of quietness or speech budget',()=>{const i=input({focus:false,lastTypingAt:now,active:m(1),queue:[m(0,'user')],ledger:{...emptyLedger(now),speech:[now-1,now-2,now-3]}});expect(mascotDirector(i).moment?.id).toBe('user')})
  it('P1 cannot interrupt P0',()=>expect(mascotDirector(input({active:m(0),queue:[m(1,'intro')]})).moment?.id).toBe('test'))
  it('P2 waits for focus and five seconds without typing',()=>{expect(mascotDirector(input({lastTypingAt:now})).moment).toBeNull();expect(mascotDirector(input({focus:false})).moment).toBeNull();expect(mascotDirector(input()).moment?.priority).toBe(2)})
  it('P2 expires at end of day',()=>{const pending=mascotDirector(input({focus:false}));const next=mascotDirector(input({now:now+86400000,prefs:{...DEFAULT_PREFS,holidays:false},queue:pending.queue,lastTypingAt:now+86400000}));expect(next.queue.some(x=>x.id===pending.queue[0].id)).toBe(false)})
  it('P3 drops when busy',()=>expect(mascotDirector(input({active:m(0),queue:[m(3)]})).queue.some(x=>x.priority===3)).toBe(false))
  it('spaces unprompted speech at least ten minutes',()=>expect(mascotDirector(input({ledger:{...emptyLedger(now),speech:[now-SPEECH_GAP_MS+1]}})).moment).toBeNull())
  it('caps speech at three per hour',()=>expect(mascotDirector(input({ledger:{...emptyLedger(now),speech:[now-1800000,now-1200000,now-600000]}})).moment).toBeNull())
  it('persists a daily holiday greeting and skips the morning line',()=>{const r=mascotDirector(input());const reload=mascotDirector(input({now:now+SPEECH_GAP_MS,ledger:JSON.parse(JSON.stringify(r.ledger))}));expect(reload.moment).toBeNull();expect(r.ledger.greetedDate).toBe('2026-12-25')})
  it('sleep defers P2 into the wake line',()=>{const asleep=mascotDirector(input({sleeping:true,lastInputAt:now-400000}));expect(asleep.moment).toBeNull();const wake=mascotDirector(input({sleeping:true,queue:asleep.queue,ledger:asleep.ledger}));expect(wake.moment?.priority).toBe(1);expect(wake.moment?.line).toBe('Merry Christmas!')})
  it.each(['disco','gameOpen'] as const)('%s suspends P2 and P3',key=>{const r=mascotDirector(input({[key]:true,queue:[m(3)]}));expect(r.moment).toBeNull();expect(r.queue.some(x=>x.priority===3)).toBe(false)})
  it('breaks require continuous input and never fire while away',()=>{const prefs={...DEFAULT_PREFS,holidays:false,breaks:true};const ledger={...emptyLedger(now),periods:['2026-12-25-morning']};const i=input({prefs,ledger,continuousInputAt:now-BREAK_MS});expect(mascotDirector(i).moment?.id).toBe('break-2026-12-25');expect(mascotDirector({...i,lastInputAt:now-400000}).moment).toBeNull();expect(mascotDirector({...i,ledger:{...ledger,lastBreakAt:now-100}}).moment).toBeNull()})
  it('Christmas night keeps Santa over the nightcap',()=>expect(mascotDirector(input({now:new Date(2026,11,25,1).getTime()})).outfit.head).toBe('santa'))
  it('plays after two minutes, switches no sooner than 45 seconds and naps after five',()=>{const i=input({lastInputAt:now-120000,prefs:{...DEFAULT_PREFS,holidays:false}});expect(mascotDirector(i).base).toBe('hula');expect(mascotDirector({...i,playing:'read',lastPlayAt:now-44000}).base).toBe('read');expect(mascotDirector({...i,lastInputAt:now-300000}).base).toBe('sleep')})
})
