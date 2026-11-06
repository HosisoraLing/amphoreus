import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { AmphoreusStore } from '../src/amphoreus/store.ts'
import { ConsoleAuth, base32, totp } from '../src/amphoreus/console-auth.ts'
const closes: (()=>void)[]=[]
afterEach(()=>{for(const close of closes.splice(0))close()})
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'console-auth-')),host=new Store(join(dir,'state.sqlite')),store=new AmphoreusStore(host)
  closes.push(()=>{host.close();rmSync(dir,{recursive:true})})
  const identities=[{user:'owner',role:'admin' as const,token:'a'.repeat(40)}]
  let now=Date.UTC(2026,10,4,1,0,0)
  const auth=new ConsoleAuth(store,identities,'role',()=>now)
  return {auth,store,identities,clock:()=>now,advance:()=>{now+=30000},code:(secret:string)=>totp(secret,Math.floor(now/30000))}
}
it('matches RFC 6238 SHA1 vectors and base32 without a network dependency',()=>{
 const secret=base32(Buffer.from('12345678901234567890'))
 expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
 expect(totp(secret,Math.floor(59/30))).toBe('287082')
 expect(totp(secret,Math.floor(1111111109/30))).toBe('081804')
 expect(totp(secret,Math.floor(20000000000/30))).toBe('353130')
})
it('requires an existing identity and confirmed OTP; encrypts secrets and rejects OTP replay after restart',async()=>{
 const {auth,store,identities,advance,clock,code}=setup()
 expect(await auth.begin('invalid','a strong password','Amphoreus')).toBeUndefined()
 const pending=(await auth.begin(identities[0]!.token,'a strong password','Amphoreus'))!
 expect(pending.uri).toContain('otpauth://totp/Amphoreus%3Aowner')
 expect(auth.enrolled('owner')).toBe(false)
 expect(await auth.login('owner','a strong password',code(pending.secret))).toBeUndefined()
 const result=auth.confirm(pending.challenge,code(pending.secret))!
 expect(result.recovery).toHaveLength(10);expect(auth.enrolled('owner')).toBe(true)
 const raw=JSON.stringify(store.record('console-auth',JSON.stringify(['role','owner'])))
 expect(raw).not.toContain(pending.secret);expect(raw).not.toContain('a strong password');expect(raw).not.toContain(result.recovery[0])
 expect(await auth.login('owner','a strong password',code(pending.secret))).toBeUndefined()
 advance();expect(await auth.login('owner','wrong password',code(pending.secret))).toBeUndefined()
 const concurrent=await Promise.all([auth.login('owner','a strong password',code(pending.secret)),auth.login('owner','a strong password',code(pending.secret))])
 expect(concurrent.filter(Boolean)).toHaveLength(1)
 expect(auth.confirm(pending.challenge,code(pending.secret))).toBeUndefined()
 const restarted=new ConsoleAuth(store,identities,'role',clock)
 expect(restarted.enrolled('owner')).toBe(true)
 expect(await restarted.login('owner','a strong password',code(pending.secret))).toBeUndefined()
 expect(await auth.begin(identities[0]!.token,'another password','Amphoreus')).toBeUndefined()
})
it('supports single-use recovery, authenticated reset and duplicate identity rejection',async()=>{
 const {auth,identities,code}=setup(),password='a strong password'
 const pending=(await auth.begin(identities[0]!.token,password,'Amphoreus'))!,result=auth.confirm(pending.challenge,code(pending.secret))!
 const attempts=await Promise.all([auth.login('owner',password,result.recovery[0]!),auth.login('owner',password,result.recovery[0]!)])
 expect(attempts.filter(Boolean)).toHaveLength(1)
 expect(await auth.reset('owner','wrong',result.recovery[1]!)).toBeUndefined()
 expect(await auth.reset('owner',password,result.recovery[1]!)).toMatchObject({user:'owner'})
 expect(auth.enrolled('owner')).toBe(false)
 expect(await auth.login('owner',password,result.recovery[2]!)).toBeUndefined()
 identities.push({...identities[0]!,token:'b'.repeat(40)})
 expect(await auth.begin(identities[0]!.token,password,'Amphoreus')).toBeUndefined()
})
it('expires challenges and limits guesses without replacing an enrolled identity',async()=>{
 const {auth,identities,advance,code}=setup(),pending=(await auth.begin(identities[0]!.token,'a strong password','Amphoreus'))!
 for(let i=0;i<11;i++)advance()
 expect(auth.confirm(pending.challenge,code(pending.secret))).toBeUndefined()
 const fresh=(await auth.begin(identities[0]!.token,'a strong password','Amphoreus'))!
 for(let i=0;i<5;i++)auth.confirm(fresh.challenge,'not-six-digits')
 expect(auth.confirm(fresh.challenge,code(fresh.secret))).toBeUndefined()
})
