import { describe, expect, it } from 'vitest'
import { addDays, easter, occasionOn, ymd } from './occasions'
const install=new Date(2020,10,20)
describe('Gregorian calendar',()=>{
  it.each([[2025,'2025-04-20','2025-03-04'],[2026,'2026-04-05','2026-02-17'],[2027,'2027-03-28','2027-02-09'],[2028,'2028-04-16','2028-02-29'],[2029,'2029-04-01','2029-02-13'],[2030,'2030-04-21','2030-03-05']] as const)('Easter and Carnival in %i',(year,e,c)=>{expect(ymd(easter(year))).toBe(e);expect(ymd(addDays(easter(year),-47))).toBe(c)})
  it('resolves Dia dos Namorados before Festa Junina',()=>expect(occasionOn(new Date(2026,5,12),install)?.id).toBe('namorados'))
  it('spans the year boundary',()=>{expect(occasionOn(new Date(2026,11,31),install)?.id).toBe('reveillon');expect(occasionOn(new Date(2027,0,1),install)?.id).toBe('reveillon')})
  it('celebrates only after the first install year',()=>{expect(occasionOn(new Date(2020,10,20),install)).toBeUndefined();expect(occasionOn(new Date(2021,10,20),install)?.line(new Date(2021,10,20))).toBe('1 year together!')})
})
