import { occasions } from '../../mascot/occasions'
import { getMascotFirstSeen } from '../../mascot/mascotPrefs'
import { Text } from '../ui/Text'
import { Group, Row } from './shared'
import { Toggle } from '../ui/settingsPrimitives'
import { Segmented } from '../ui/SegmentedControl'
import { Select } from '../ui/Select'
import { Button } from '../ui/Button'
import { useMascotPrefs, setMascotPrefs, requestMascotAction, type MascotPrefs } from '../../mascot/mascotPrefs'
const toggles: { key: keyof Pick<MascotPrefs,'enabled'|'holidays'|'sounds'|'breaks'|'nap'|'background'>; title: string; desc: string }[] = [
  {key:'enabled',title:'Mascot',desc:"Shows the mascot above the rail's footer buttons."},
  {key:'holidays',title:'Celebrate holidays',desc:'Outfits for the dates in the calendar below.'},
  {key:'sounds',title:'Sounds',desc:'Short beeps when you interact with it.'},
  {key:'breaks',title:'Break reminders',desc:'After 90 minutes of continuous input, it stretches and suggests a break.'},
  {key:'nap',title:"Nap when I'm away",desc:'Plays on its own after 2 minutes without input and falls asleep after 5.'},
  {key:'background',title:'Animate when Houston is in the background',desc:'All motion pauses while the window is hidden or unfocused.'}
]
export function MascotSettings(): React.JSX.Element {
  const prefs=useMascotPrefs()
  const toggle=(row:typeof toggles[number]):React.JSX.Element=><Row key={row.key} title={row.title} desc={row.desc}><Toggle on={prefs[row.key]} aria-label={row.title} onChange={v=>setMascotPrefs({[row.key]:v})}/></Row>
  return <><Group heading="Mascot">
    {toggle(toggles[0])}
    <Row title="Style" desc="The brand artwork, or a pixel sprite that redraws at 10 fps."><Select aria-label="Style" value={prefs.style} options={[{value:'rig',label:'Brand art'},{value:'pixel',label:'Pixel'}]} onChange={v=>setMascotPrefs({style:v as MascotPrefs['style']})}/></Row>
    <Row title="Colors" desc="Recolors the headset and ring."><Segmented aria-label="Colors" value={prefs.colors} options={(['classic','aurora','sunset','mono'] as const).map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))} onChange={colors=>setMascotPrefs({colors})}/></Row>
    <Row title="Hat" desc="Holiday outfits take over on their dates."><Segmented aria-label="Hat" value={prefs.hat} options={(['none','beanie','cap','crown'] as const).map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))} onChange={hat=>setMascotPrefs({hat})}/></Row>
    {toggles.slice(1,5).map(toggle)}
    <Row title="Meet the mascot again" desc="Replays the introduction."><Button disabled={!prefs.enabled} onClick={()=>requestMascotAction('intro')}>Replay intro</Button></Row>
    {toggle(toggles[5])}
  </Group><Group heading="Holiday outfits">
    {occasions(new Date(`${getMascotFirstSeen()}T12:00:00`)).map(occasion => <Row key={occasion.id} title={occasion.name} desc={occasion.rule}><Text size="small" tone="muted">{occasion.outfit}</Text></Row>)}
  </Group></>
}
