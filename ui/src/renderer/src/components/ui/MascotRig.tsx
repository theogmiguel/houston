import { useEffect, useRef, useMemo, type CSSProperties } from 'react'
import { ACC, SLOT, type Accessory } from './mascotAccessories'
import { FX, fxHtml } from './mascotParticles'
import { draw } from './mascotPixel'
import type { Mood, Outfit } from '../../mascot/mascotDirector'
import { useMascotMotion } from './useMascotMotion'
import './Mascot.css'
import armL from './mascotAssets/arm_l.png'
import armR from './mascotAssets/arm_r.png'
import torso from './mascotAssets/torso.png'
import core from './mascotAssets/core.png'
import head from './mascotAssets/head.png'
import eyes from './mascotAssets/eyes.png'

function accessoryHtml(items: (Accessory | undefined)[], slot?: string): string {
  return items.filter((item): item is Accessory => !!item && (!slot || SLOT[item] === slot)).map((item) => ACC[item]).join('')
}
export function MascotParticles({ kind, once = false }: { kind?: string; once?: boolean }): React.JSX.Element | null {
  const html = useMemo(() => kind && FX[kind] ? fxHtml(once ? FX[kind]().slice(0, 7) : FX[kind](), once) : '', [kind, once])
  return html ? <span className="mascot-fx loop-anim" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} /> : null
}
export function MascotRig({ mood = 'idle', outfit = {}, size = 64, background = false }: { mood?: Mood; outfit?: Outfit; size?: number; background?: boolean }): React.JSX.Element {
  const { reduced, paused } = useMascotMotion(background)
  const items = [outfit.body, outfit.head, outfit.face, outfit.hand]
  return <div className={`mascot-rig mascot-motion loop-anim a-${mood}`} data-reduced={reduced} data-paused={paused} data-background={background} style={{ '--size': `${size}px` } as CSSProperties} role="img" aria-label="Houston mascot">
    <div className="l body">
      <div className="l arm-l"><div className="l"><img src={armL} alt="" /></div></div>
      <div className="l torso"><img src={torso} alt="" /><img className="core" src={core} alt="" /><div className="core-glow" /></div>
      <svg className="mascot-acc acc-body" viewBox="0 0 100 100" aria-hidden="true" dangerouslySetInnerHTML={{ __html: accessoryHtml(items, 'body') }} />
      <div className="l head"><div className="l"><img src={head} alt="" /><div className="ring-sweep"><i /></div><div className="l eyes-look" style={{transform: mood === "read" ? "translate(0, 2.6%)" : mood === "stars" ? "translate(1%, -3%)" : undefined}}><img className="eyes" src={eyes} alt="" /></div><svg className="mascot-acc acc-head" viewBox="0 0 100 100" aria-hidden="true" dangerouslySetInnerHTML={{ __html: accessoryHtml(items, 'head') }} /></div></div>
      <div className="l arm-r"><div className="l"><img src={armR} alt="" /><svg className="mascot-acc acc-hand" viewBox="0 0 100 100" aria-hidden="true" dangerouslySetInnerHTML={{ __html: accessoryHtml(items, 'hand') }} /></div></div>
    </div>
    <span className="zz">z</span><span className="zz">z</span>
    {mood === 'party' && [[-120,-60,'#3fe0ff',8,18],[120,-80,'#a78bfa',78,10],[-90,-130,'#e0fdff',22,4],[100,-140,'#3fe0ff',66,2],[0,-170,'#c4b5fd',45,0]].map(([dx,dy,c,x,y], k) => <i key={k} className="spark" style={{ '--dx': `${dx}%`, '--dy': `${dy}%`, left: `${x}%`, top: `${y}%`, background: c } as CSSProperties} />)}
  </div>
}
export function MascotPixel({ mood, outfit, reduced, paused }: { mood: Mood; outfit: Outfit; reduced: boolean; paused: boolean }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d'); if (!ctx) return
    draw(ctx, mood === 'sleep' ? 'unavailable' : 'idle', 3)
    if (paused || reduced) return
    let raf = 0, frame = 0, last = 0
    const tick = (t: number): void => { if (t - last >= 100) { last = t; draw(ctx, mood === 'sleep' ? 'unavailable' : 'idle', ++frame) } raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf)
  }, [mood, reduced, paused])
  return <span className="mascot-pxwrap"><canvas ref={canvas} width={48} height={44} /><svg className="mascot-acc" viewBox="3.2 4.8 95.7 87.7" aria-hidden="true" dangerouslySetInnerHTML={{ __html: accessoryHtml([outfit.body, outfit.head, outfit.face, outfit.hand]) }} /></span>
}
export function MascotRigSpecimen(): React.JSX.Element {
  return <div className="flex flex-wrap gap-[var(--space-5)]">{(['idle','wave','party','sleep','hula','read','stars','happy','call','hurt'] as Mood[]).map((mood) => <MascotRig key={mood} mood={mood} size={112} outfit={{ body: mood === 'read' ? 'book' : undefined }} />)}</div>
}
