import { useNativeOverlaySuppression } from '../../layout/nativeSuppression'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MascotArt } from './MascotArt'
import { useMascotSlot } from '../../mascot/mascotSlots'
import { INTRO } from '../../mascot/lines'
import { persistLedger, readLedger, type Mood } from '../../mascot/mascotDirector'
import { useMascotMotion } from './useMascotMotion'
export function MascotMeet({ anchor, onKeep, onOff }: { anchor: RefObject<HTMLButtonElement | null>; onKeep: () => void; onOff: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useNativeOverlaySuppression('popover',true,ref)
  const [pos, setPos] = useState({left: 0, top: 0})
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const place = (): void => { const b = anchor.current?.getBoundingClientRect(); if(b) setPos({left: Math.min(b.right + 14, window.innerWidth - 274), top: Math.max(8, b.bottom - (ref.current?.offsetHeight ?? 150) + 8)}) }
    place(); ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); window.addEventListener('resize',place)
    return () => { window.removeEventListener('resize',place); previous?.focus() }
  }, [anchor])
  return createPortal(<div ref={ref} className="mascot-meet" role="dialog" aria-label="Meet Houston" style={pos} onKeyDown={(e) => {if(e.key === 'Escape') onKeep(); if(e.key === 'Tab') {const buttons=ref.current?.querySelectorAll('button'); if(buttons?.length) { e.preventDefault(); (document.activeElement===buttons[0] ? buttons[1] : buttons[0]).focus() }}}}>
    <b>Meet Houston</b><p>Houston now has a mascot. It's here to keep you company and doesn't track your agents.</p><div className="acts"><button className="primary" type="button" onClick={onKeep}>Keep it</button><button type="button" onClick={onOff}>Turn off</button></div><small>You can change this anytime in Settings › Mascot.</small>
  </div>,document.body)
}
export default function MascotIntro({ onDone, onAddWorkspace, onOpenSettings, inline = false, preview = false }: { onDone: () => void; onAddWorkspace?: () => void; onOpenSettings?: () => void; inline?: boolean; preview?: boolean }): React.JSX.Element {
  const { reduced } = useMascotMotion()
  const [step,setStep] = useState(0), [typed,setTyped] = useState(preview ? INTRO()[0].t.length : 0), [leaving,setLeaving] = useState(false)
  const stage = useMascotSlot(2), root = useRef<HTMLDivElement>(null)
  useNativeOverlaySuppression('modal',!inline,root)
  const lines=INTRO(), line=lines[step], done=typed>=line.t.length
  useEffect(() => { if(preview)return; if(reduced) {setTyped(line.t.length);return} if(done) return; const t=setTimeout(()=>setTyped(n=>n+1),24); return ()=>clearTimeout(t) },[typed,line.t,reduced,done,preview])
  useEffect(() => { if(preview)return; if(!done || step===2) return; const t=setTimeout(()=>{setStep(n=>n+1);setTyped(0)},2600); return ()=>clearTimeout(t) },[done,step,preview])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; root.current?.focus()
    return () => { previous?.focus(); stage.current?.getAnimations?.().forEach((a)=>a.cancel()) }
  },[])
  function land(): void { const ledger=readLedger(Date.now());ledger.introSeen=true;persistLedger(ledger);window.dispatchEvent(new Event('houston-mascot-landed'));onDone() }
  function leave(action?: () => void): void {
    if(leaving) return; setLeaving(true)
    land(); action?.()
  }
  const content=<div ref={root} tabIndex={-1} className={`mascot-welcome mascot-motion ${leaving ? 'leaving' : ''}`} data-reduced={reduced} role={inline ? undefined : 'dialog'} aria-label="Meet Houston" aria-modal={inline ? undefined : true} data-testid="mascot-intro" onKeyDown={(e)=>{ if(e.key==='Escape')leave(); if(e.key==='Tab'){const buttons=root.current?.querySelectorAll<HTMLButtonElement>('button:not([hidden])');const active=Array.from(buttons??[]).filter(b=>b.getClientRects().length);if(active.length){e.preventDefault();const index=active.indexOf(document.activeElement as HTMLButtonElement);active[(index+(e.shiftKey ? active.length-1 : 1))%active.length].focus()}}}} onClick={(e)=>{if((e.target as HTMLElement).closest('button') || leaving)return; if(!done)setTyped(line.t.length);else if(step<2){setStep(n=>n+1);setTyped(0)}}}>
    <div className="mascot-intro"><div className="mascot-intro-stage"><div ref={stage}><MascotArt size={210} mood={leaving ? 'work' : line.m as Mood} /></div><div className="mascot-speech" aria-live="polite"><span>{line.t.slice(0,typed)}</span><span className="mascot-caret loop-anim" /></div></div><div className="mascot-dots">{[0,1,2].map(n=><i key={n} className={n<=step?'on':undefined}/>)}</div><div className="mascot-cta" data-awaiting={step!==2 || !done}><button type="button" className="primary" onClick={()=>leave(onAddWorkspace)}>Add workspace</button><button type="button" onClick={()=>leave(onOpenSettings)}>Open settings</button></div><span className="mascot-continue">{step===2 && done ? '' : 'Click to continue'}</span></div><button className="mascot-skipintro" type="button" onClick={()=>leave()}>Skip intro</button>
  </div>
  return inline ? content : createPortal(content,document.body)
}
