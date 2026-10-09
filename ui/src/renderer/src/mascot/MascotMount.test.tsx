// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MascotMount } from './MascotMount'
import { DEFAULT_PREFS, setMascotPrefsForTests } from './mascotPrefs'
import { emptyLedger, persistLedger, readLedger } from './mascotDirector'
vi.mock('../components/ui/MascotRig',()=>({MascotRig:()=> <span data-testid="rig"/>,MascotPixel:()=> <span/>,MascotParticles:()=>null}))
beforeEach(()=>{localStorage.clear();setMascotPrefsForTests({...DEFAULT_PREFS});vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}))})
afterEach(()=>{cleanup();vi.unstubAllGlobals();setMascotPrefsForTests({...DEFAULT_PREFS})})
it('off mounts no companion or listeners',()=>{setMascotPrefsForTests({...DEFAULT_PREFS,enabled:false});const {container}=render(<MascotMount existingUser/>);expect(container.innerHTML).toBe('')})
it('existing-user intro is shown once after acceptance across reload',async()=>{
  persistLedger(emptyLedger(Date.now()))
  const first=render(<MascotMount existingUser/>);await screen.findByTestId('mascot-companion')
  await screen.findByRole('dialog',{name:'Meet Houston'},{timeout:3000})
  fireEvent.click(screen.getByRole('button',{name:'Keep it'}));expect(readLedger(Date.now()).introSeen).toBe(true)
  first.unmount();render(<MascotMount existingUser/>);await screen.findByTestId('mascot-companion');await act(async()=>{await new Promise(r=>setTimeout(r,1700))});expect(screen.queryByRole('dialog',{name:'Meet Houston'})).toBeNull()
})
