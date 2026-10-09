import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavigationRailCompanion, MascotDiscoScope } from '../components/ui/NavigationRailCompanion'
import { MascotMeet } from '../components/ui/MascotIntro'
import { useMascotMotion } from '../components/ui/useMascotMotion'
import { consumeMascotAction, getMascotPrefs, useMascotPrefs, setMascotPrefs, type MascotAction } from './mascotPrefs'
import { mascotDirector, readLedger, persistLedger, PLAY_AFTER_MS, type DirectorInput, type Mood } from './mascotDirector'
import { MascotDockContext } from './mascotRailContext'
import { useMascotDrag } from './useMascotDrag'
import { placeMascotBubble } from './mascotBubble'
import { returnMascotToRail, useMascotPlacement } from './mascotPosition'
import { LINES } from './lines'
const Intro = lazy(() => import('../components/ui/MascotIntro'))
const Game = lazy(() => import('../components/ui/MascotGame'))
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)]
const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a']
function initial(): DirectorInput {
  const now = Date.now()
  return { now, prefs: getMascotPrefs(), focus: document.hasFocus(), lastInputAt: now, lastTypingAt: now, theme: document.documentElement.dataset.theme ?? 'graphite', sleeping: false, playing: null, disco: false, gameOpen: false, active: null, queue: [], ledger: readLedger(now), continuousInputAt: now, lastPlayAt: now }
}
export default function MascotCompanion({ existingUser, firstRun }: { existingUser: boolean; firstRun: boolean }): React.JSX.Element {
  const dock = useContext(MascotDockContext)
  const placement = useMascotPlacement()
  const prefs = useMascotPrefs(), motion = useMascotMotion(prefs.background)
  const motionRef = useRef(motion)
  motionRef.current = motion
  const [initialState] = useState(initial)
  const state = useRef(initialState)
  const [view, setView] = useState(() => {const result=mascotDirector(state.current);Object.assign(state.current,{active:result.moment,queue:result.queue,ledger:result.ledger});return result})
  const [line,setLine] = useState<string>()
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastMoment = useRef<string | undefined>(undefined)
  const [effect, setEffect] = useState<string>(), [bump, setBump] = useState<string>()
  const [intro, setIntro] = useState(false), [game, setGame] = useState(false), [meet, setMeet] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const audio = useRef<AudioContext | null>(null)
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const [disco, setDisco] = useState(false)
  const pending = useRef(false)
  const lifecycleOpen = useRef(firstRun || intro || game)
  lifecycleOpen.current = firstRun || intro || game
  function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> { const t = setTimeout(() => { timers.current.delete(t); fn() }, ms); timers.current.add(t); return t }
  function cancel(t: ReturnType<typeof setTimeout> | undefined): void {if(t!==undefined){clearTimeout(t);timers.current.delete(t)}}
  function tick(): void {
    const s = state.current; s.now = Date.now(); s.prefs = getMascotPrefs(); s.focus = document.hasFocus() && !document.hidden
    s.gameOpen = lifecycleOpen.current
    const next = mascotDirector(s)
    Object.assign(s, { active: next.moment, queue: next.queue, ledger: next.ledger, sleeping: next.sleeping, playing: next.playing, lastPlayAt: next.lastPlayAt })
    if(next.moment && lastMoment.current !== next.moment.id) {
      lastMoment.current=next.moment.id
      cancel(bubbleTimer.current)
      setLine(next.moment.line || undefined)
      bubbleTimer.current=later(()=>setLine(undefined),next.moment.lineDuration ?? Math.max(1,next.moment.until-s.now))
      later(tick,Math.max(1,next.moment.until-s.now))
    }
    if(!next.moment)lastMoment.current=undefined
    persistLedger(next.ledger); setView(next)
  }
  function chirp(kind = 'tap'): void {
    if (!getMascotPrefs().sounds) return
    try {
      audio.current ??= new AudioContext(); const ctx = audio.current; void ctx.resume()
      const notes: Record<string, number[]> = { tap: [660,880], happy: [880,1175,1320], flip: [520,1040], boing: [300,180,420], disco: [523,659,784,1046] }
      notes[kind].forEach((hz, k) => { const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + k * .07; o.type = 'sine'; o.frequency.setValueAtTime(hz,t); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(.035,t + .008); g.gain.exponentialRampToValueAtTime(.001,t + .12); o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + .13) })
    } catch { /* Sound is optional when WebAudio is unavailable. */ }
  }
  function moment(mood: Mood, line: string, duration = 2400, priority: 0 | 1 = 0, lineDuration = duration): void {
    const now = Date.now(), s = state.current
    s.lastInputAt = now
    s.queue.push({ id: `user-${now}`, priority, mood, line, lineDuration, duration, until: now + duration, expires: now + duration }); tick()
  }
  function fx(kind: string): void { if (!motionRef.current.reduced) { setEffect(`${kind}:${Date.now()}`); later(() => setEffect(undefined), 3600) } }
  function animate(kind: string): void { if (!motionRef.current.reduced) { setBump(undefined); later(() => setBump(kind), 0); later(() => setBump(undefined), 1500) } }
  const petCooldown = useRef(0)
  function act(action: MascotAction): void {
    if (action === 'dock') { returnMascotToRail(); return }
    if (state.current.sleeping && (action === 'hi' || action === 'pet')) { state.current.lastInputAt=Date.now();tick();return }
    if (action === 'intro') { setMeet(false); setIntro(true); state.current.gameOpen = true; return }
    if (action === 'game') { setGame(true); state.current.gameOpen = true; moment('party','Ring Invaders! Save the grid!'); return }
    if (action === 'disco') { state.current.disco = true; setDisco(true); moment(motionRef.current.reduced ? 'idle' : 'hula','Disco mode!',9000,0,3000); chirp('disco'); fx('confetti'); later(() => { state.current.disco = false; setDisco(false) }, 9000); return }
    if (action === 'pet') {
      if (Date.now() < petCooldown.current) return
      petCooldown.current = Date.now() + 1600
      moment('happy',pick(['Hehe!','That tickles!','More, please.','♥']),1800,0,1500); fx('hearts'); chirp('happy'); return
    }
    const [mood,duration]=pick<[Mood,number]>([['wave',3400],['party',2200]])
    moment(mood,pick(LINES()),duration,0,2400); if (getMascotPrefs().style === 'pixel') animate('hop'); chirp()
  }
  useEffect(() => {
    persistLedger(state.current.ledger)
    let code = 0
    const input = (e: Event): void => {
      const now = Date.now(), s = state.current
      if (now - s.lastInputAt >= PLAY_AFTER_MS) s.continuousInputAt = now
      s.lastInputAt = now
      if (e.type === 'keydown') s.lastTypingAt = now
    }
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.matches?.('input, textarea, [contenteditable="true"]')) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      code = k === KONAMI[code] ? code + 1 : k === KONAMI[0] ? 1 : 0
      if (code === KONAMI.length) { code = 0; act('disco') }
    }
    const action = (e: Event): void => { consumeMascotAction();act((e as CustomEvent<MascotAction>).detail) }
    const landed = (): void => { state.current.gameOpen = false; seen(); moment('party',"I'll hang out down here. Click me anytime!",3600) }
    const observer = new MutationObserver(() => {
      const theme = document.documentElement.dataset.theme ?? 'graphite'
      if (state.current.theme === theme) return
      state.current.theme = theme; moment('idle',theme === 'paper' ? 'Bright in here!' : 'Ahh, much better.',2000)
      if (theme !== 'paper') animate('glowup'); else if (getMascotPrefs().style === 'pixel') animate('hop')
    })
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const look = (e: PointerEvent): void => {
      if (state.current.sleeping || state.current.playing || state.current.active || motionRef.current.reduced || getMascotPrefs().style === 'pixel') return
      const el=button.current?.querySelector<HTMLElement>('.eyes-look'), b=button.current?.getBoundingClientRect()
      if(!el || !b)return
      const dx=e.clientX-(b.left+b.width/2),dy=e.clientY-(b.top+b.height*.35),d=Math.hypot(dx,dy),k=Math.min(d/80,1)
      el.style.transform=d>460 || d<8 ? '' : `translate(${dx/d*2.6*k}%, ${dy/d*1.8*k}%)`
    }
    window.addEventListener('pointermove',look,{passive:true})
    window.addEventListener('keydown',input,{capture:true,passive:true}); window.addEventListener('pointerdown',input,{capture:true,passive:true})
    window.addEventListener('keydown',key); window.addEventListener('houston-mascot-action',action); window.addEventListener('houston-mascot-landed',landed)
    const queuedAction=consumeMascotAction();if(queuedAction)act(queuedAction)
    const interval = setInterval(tick,1000)
    return () => { pending.current = false; lastMoment.current=undefined; clearInterval(interval); observer?.disconnect(); window.removeEventListener('pointermove',look); window.removeEventListener('keydown',input,true); window.removeEventListener('pointerdown',input,true); window.removeEventListener('keydown',key); window.removeEventListener('houston-mascot-action',action); window.removeEventListener('houston-mascot-landed',landed); timers.current.forEach(clearTimeout); timers.current.clear(); void audio.current?.close() }
  }, [])
  useEffect(() => {
    if (existingUser && !firstRun && !state.current.ledger.introSeen && !pending.current) {
      pending.current = true; later(() => { animate('arrive'); moment('wave','',3400,1) },450); later(() => setMeet(true),1500)
    }
  }, [existingUser, firstRun])
  useEffect(() => {
    const footer = (dock?.closest('aside') ?? button.current?.closest('aside'))?.querySelector('.railfoot')
    footer?.classList.toggle('mascot-disco-footer', disco && !motionRef.current.reduced)
    footer?.classList.toggle('loop-anim',disco && !motionRef.current.reduced)
    return () => footer?.classList.remove('mascot-disco-footer','loop-anim')
  }, [disco, motion.reduced, dock])
  function seen(): void { state.current.ledger.introSeen = true; persistLedger(state.current.ledger); setMeet(false) }
  const rub = useRef({ x: null as number | null, dir: 0, times: [] as number[] })
  const clicks = useRef<number[]>([]), clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const suppressed = useRef(false)
  function dockBoing(dx: number, dy: number): void {
    const sp = button.current?.querySelector<HTMLElement>('.sprite'); if (!sp) return
    const cl = (v: number): number => Math.max(-38, Math.min(38, v * .42))
    if (!motionRef.current.reduced) sp.animate?.([{transform:'scale(1.06)'},{transform:`translate(${-cl(dx)*.35}px, ${-cl(dy)*.35}px) rotate(${-dx*.06}deg) scale(.94, 1.06)`},{transform:`translate(${cl(dx)*.14}px, ${cl(dy)*.14}px) rotate(${dx*.03}deg)`},{transform:`translate(${-cl(dx)*.05}px, 0)`},{transform:'none'}],{duration:700,easing:'ease-out'})
    moment('idle',pick(['Boing!','Whoa!','Again!']),1300); chirp('boing')
  }
  const drag = useMascotDrag(button, dockBoing, () => { suppressed.current = true; cancel(clickTimer.current); later(() => { suppressed.current = false }, 50) })
  useLayoutEffect(() => {
    const bubble = button.current?.querySelector<HTMLElement>('.bubble')
    const place = (): void => placeMascotBubble(button.current)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (bubble) observer?.observe(bubble)
    window.addEventListener('resize', place)
    place()
    return () => { observer?.disconnect(); window.removeEventListener('resize', place) }
  }, [line, placement.position, placement.dragging])

  return <>
    <MascotDiscoScope active={disco}>
      <NavigationRailCompanion ref={button} prefs={prefs} outfit={view.outfit} mood={view.moment?.mood ?? view.base} line={line} effect={effect} bump={bump} {...motion}
        onClick={() => { if (suppressed.current) return; const now = Date.now(); clicks.current = clicks.current.filter((t) => now-t < 4000); clicks.current.push(now); cancel(clickTimer.current); if (clicks.current.length >= 10) { clicks.current=[]; act('game') } else clickTimer.current=later(() => act('hi'),240) }}
        onDoubleClick={() => { cancel(clickTimer.current); if(state.current.sleeping){state.current.lastInputAt=Date.now();tick();return} animate('flip'); moment('idle','Wheee!',1200); chirp('flip') }}
        onPointerDown={drag.down}
        onPointerMove={(e) => {
          if (drag.move(e)) return
          const r=rub.current, dx=r.x===null?0:e.clientX-r.x, dir=Math.sign(dx), now=Date.now(); if(Math.abs(dx)>2 && dir!==r.dir) { r.times.push(now); r.dir=dir } r.x=e.clientX; r.times=r.times.filter(t=>now-t<1200); if(r.times.length>=5) { r.times=[];act('pet') }
        }} onPointerLeave={() => {rub.current.times=[];rub.current.x=null}} onPointerUp={drag.up} onPointerCancel={drag.cancel} onLostPointerCapture={drag.cancel} />
    </MascotDiscoScope>
    {meet && <MascotMeet anchor={button} onKeep={() => { seen(); moment('party','Yay! Click me anytime.') }} onOff={() => { seen(); moment('wave','Bye! Find me in Settings › Mascot.',1900); later(() => setMascotPrefs({enabled:false}),2000) }} />}
    <Suspense fallback={null}>{intro && <Intro onDone={() => {setIntro(false); state.current.gameOpen=false; seen(); moment('party',"I'll hang out down here. Click me anytime!",3600)}} />}{game && <Game background={prefs.background} onClose={() => {setGame(false); state.current.gameOpen=false}} onResult={(win) => { moment('party',win ? 'You saved the grid!' : 'The bugs got through. Again?',3000); if(win) { fx('confetti');chirp('disco') } }} />}</Suspense>
  </>
}
