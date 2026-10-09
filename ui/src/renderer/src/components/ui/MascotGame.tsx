import { useNativeOverlaySuppression } from '../../layout/nativeSuppression'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { draw } from './mascotPixel'
import { useMascotMotion } from './useMascotMotion'
import './Mascot.css'
interface Bug { x: number; y: number; alive: boolean; row: number }
interface GameState { px: number; shots: {x: number; y: number}[]; bugs: Bug[]; dir: number; step: number; stepEvery: number; frame: number; keys: Record<string, boolean>; over: 'win' | 'lose' | null; score: number }
export default function MascotGame({ onClose, onResult, background = false }: { onClose: () => void; onResult: (win: boolean) => void; background?: boolean }): React.JSX.Element {
 const callbacks=useRef({onClose,onResult});callbacks.current={onClose,onResult}
 const canvas=useRef<HTMLCanvasElement>(null), root=useRef<HTMLDivElement>(null)
 useNativeOverlaySuppression('modal',true,root)
 const resume=useRef<(()=>void)|null>(null)
 const motion=useMascotMotion(background), paused=useRef(motion.paused)
 paused.current=motion.paused
 useEffect(()=>{if(!motion.paused)resume.current?.()},[motion.paused])
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement | null; root.current?.focus()
  const g=canvas.current!.getContext('2d')!
  const sprite=document.createElement('canvas');sprite.width=48;sprite.height=44;draw(sprite.getContext('2d')!,'idle',3)
  let gameState: GameState
  let raf=0
  function reset(): void { const bugs: Bug[]=[];for(let r=0;r<4;r++)for(let c=0;c<9;c++)bugs.push({x:40+c*26,y:22+r*18,alive:true,row:r}); gameState={px:160,shots:[],bugs,dir:1,step:0,stepEvery:32,frame:0,keys:{},over:null,score:0} }
  reset()
  function shoot(): void { if(gameState.over) reset();else if(gameState.shots.length<3)gameState.shots.push({x:gameState.px,y:172}) }
  function key(e: KeyboardEvent): void { if(e.key==='Escape'){e.preventDefault();e.stopPropagation();callbacks.current.onClose();return}if(['ArrowLeft','ArrowRight',' ','a','d','Enter'].includes(e.key)){e.preventDefault();e.stopPropagation();gameState.keys[e.key]=true;if(e.key===' ')shoot();if(e.key==='Enter'&&gameState.over)reset()}if(e.key==='Tab'){e.preventDefault();root.current?.querySelector('button')?.focus()} }
  function up(e: KeyboardEvent): void { gameState.keys[e.key]=false }
  function move(e: PointerEvent): void {const r=canvas.current!.getBoundingClientRect();gameState.px=Math.max(12,Math.min(308,(e.clientX-r.left)/r.width*320))}
  window.addEventListener('keydown',key,true);window.addEventListener('keyup',up,true);canvas.current!.addEventListener('pointermove',move);canvas.current!.addEventListener('pointerdown',shoot)
const BUG = ['0010000100', '0001001000', '0011111100', '0110110110', '1111111111', '1011111101', '1010000101', '0001101100'];
function drawBug(x: number, y: number, color: string, f: number) {
  g.fillStyle = color;
  BUG.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === '1' && !(j === 7 && f % 2 && (i < 3 || i > 6))) g.fillRect(x - 5 + i, y - 4 + j, 1, 1); }));
}
function gameTick() {
  if (!gameState || document.hidden || paused.current) return;
  raf = requestAnimationFrame(gameTick);
  gameState.frame++;
  if (!gameState.over) {
    if (gameState.keys.ArrowLeft || gameState.keys.a) gameState.px = Math.max(12, gameState.px - 2.4);
    if (gameState.keys.ArrowRight || gameState.keys.d) gameState.px = Math.min(308, gameState.px + 2.4);
    gameState.shots.forEach(s => { s.y -= 4; });
    gameState.shots = gameState.shots.filter(s => s.y > -6);
    const alive = gameState.bugs.filter(b => b.alive);
    if (++gameState.step >= Math.max(6, gameState.stepEvery - (36 - alive.length))) {
      gameState.step = 0;
      const xs = alive.map(b => b.x), edge = gameState.dir > 0 ? Math.max(...xs) > 304 : Math.min(...xs) < 16;
      if (edge) { gameState.dir *= -1; alive.forEach(b => { b.y += 6; }); } else alive.forEach(b => { b.x += 4 * gameState.dir; });
    }
    gameState.shots.forEach(s => alive.forEach(b => { if (b.alive && Math.abs(s.x - b.x) < 7 && Math.abs(s.y - b.y) < 6) { b.alive = false; s.y = -99; gameState.score += 10; } }));
    if (!gameState.bugs.some(b => b.alive)) { gameState.over = 'win'; callbacks.current.onResult(true); }
    else if (alive.some(b => b.y > 164)) { gameState.over = 'lose'; callbacks.current.onResult(false); }
  }
  g.fillStyle = '#05060f'; g.fillRect(0, 0, 320, 200);
  for (let i = 0; i < 40; i++) { g.fillStyle = i % 3 ? '#1b2050' : '#3a427f'; g.fillRect((i * 73) % 320, (i * 37 + gameState.frame * (i % 3 ? .1 : .25)) % 200, 1, 1); }
  const colors = ['#f43f5e', '#f59e0b', '#22c55e', '#3fe0ff'];
  gameState.bugs.forEach(b => { if (b.alive) drawBug(Math.round(b.x), Math.round(b.y), colors[b.row], Math.floor(gameState.frame / 20)); });
  gameState.shots.forEach(s => { g.strokeStyle = '#3fe0ff'; g.beginPath(); g.ellipse(s.x, s.y, 4, 1.6, -0.2, 0, Math.PI * 2); g.stroke(); });
  g.imageSmoothingEnabled = false; g.drawImage(sprite, Math.round(gameState.px - 12), 174, 24, 22);
  g.fillStyle = '#8d93c9'; g.font = '8px monospace'; g.fillText(`SCORE ${gameState.score}`, 6, 10);
  if (gameState.over) {
    g.fillStyle = '#05060fcc'; g.fillRect(0, 80, 320, 40);
    g.fillStyle = gameState.over === 'win' ? '#22c55e' : '#f43f5e'; g.font = '12px monospace'; g.textAlign = 'center';
    g.fillText(gameState.over === 'win' ? 'GRID SAVED' : 'GAME OVER', 160, 98);
    g.fillStyle = '#8d93c9'; g.font = '8px monospace'; g.fillText('Enter or click to play again', 160, 111); g.textAlign = 'left';
  }
}


  resume.current=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(gameTick)}
  resume.current()
  const cv=canvas.current!
  return ()=>{cancelAnimationFrame(raf);window.removeEventListener('keydown',key,true);window.removeEventListener('keyup',up,true);cv.removeEventListener('pointermove',move);cv.removeEventListener('pointerdown',shoot);previous?.focus()}
 },[])
 return createPortal(<div ref={root} tabIndex={-1} className="mascot-game" role="dialog" aria-modal="true" aria-label="Ring Invaders"><canvas ref={canvas} width={320} height={200} aria-label="Ring Invaders game board"/><div className="gbar"><span>← → move · Space shoots rings · Esc quits</span><button type="button" onClick={onClose}>Quit</button></div></div>,document.body)
}
