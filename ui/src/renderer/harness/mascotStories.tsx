import { NavigationRailFooter } from '../src/components/ui/NavigationRailFooter'
import { Button } from '../src/components/ui/Button'
import { Icon } from '../src/components/ui/Icon'
import { IconGear, IconGitPullRequest, IconChartArea, IconMoon } from '../src/components/icons'
import { useRef } from 'react'
import { MascotArt } from '../src/components/ui/MascotArt'
import { MascotParticles } from '../src/components/ui/MascotRig'
import { NavigationRailCompanion } from '../src/components/ui/NavigationRailCompanion'
import MascotIntro, { MascotMeet } from '../src/components/ui/MascotIntro'
import { SettingsMascot } from './settingsStories'
import { DEFAULT_PREFS } from '../src/mascot/mascotPrefs'
import type { Mood, Outfit } from '../src/mascot/mascotDirector'
import { MascotAppRoot } from '../src/mascot/MascotAppRoot'
import { MascotMount } from '../src/mascot/MascotMount'
export function MascotStory(): React.JSX.Element {
  const q=new URLSearchParams(location.search), mood=(q.get('mood')??'idle') as Mood
  const outfit:Outfit={head:q.get('holiday')==='christmas'?'santa':undefined,body:mood==='read'?'book':undefined,fx:q.get('holiday')==='christmas'?'snow':mood==='stars'?'stars':undefined}
  const mode=q.get('mode'), ref=useRef<HTMLButtonElement>(null)
  if(mode==='settings')return <SettingsMascot/>
  if(mode==='intro')return <div style={{position:'relative',width:'100%',height:'100%'}}><MascotIntro inline preview onDone={()=>{}}/></div>
  if(mode==='live')return <MascotAppRoot><aside style={{width:236,height:'100%',display:'flex',flexDirection:'column',justifyContent:'end',background:'var(--rail-bg)'}}><MascotMount existingUser={false}/></aside></MascotAppRoot>
  return <div style={{width:mode==='hero'?640:236,height:mode==='hero'?400:200,position:'relative',background:'var(--rail-bg)',display:'flex',flexDirection:'column',justifyContent:'end'}} data-testid="mascot-capture">
    {mode==='hero'?<div style={{margin:'auto',position:'relative'}}><MascotArt prefs={{...DEFAULT_PREFS,style:q.get('pixel')?'pixel':'rig',colors:(q.get('colors')??'classic') as typeof DEFAULT_PREFS.colors}} size={210} mood={mood} outfit={outfit}/><MascotParticles kind={outfit.fx}/></div>:<NavigationRailCompanion ref={ref} prefs={{...DEFAULT_PREFS,style:q.get('pixel')?'pixel':'rig',colors:(q.get('colors')??'classic') as typeof DEFAULT_PREFS.colors}} mood={mood} outfit={outfit} reduced={false} paused={false} line={mood==='happy'?'Hehe!':undefined}/>}
    {mode!=='hero' && <NavigationRailFooter>{[IconGear,IconGitPullRequest,IconChartArea,IconMoon].map((glyph,index)=><Button key={index} variant="subtle-icon" aria-label={['Settings','Pull requests','Usage','Switch theme'][index]}><Icon glyph={glyph} role="ui"/></Button>)}</NavigationRailFooter>}
    {mode==='meet'&&<MascotMeet anchor={ref} onKeep={()=>{}} onOff={()=>{}}/>}
  </div>
}
