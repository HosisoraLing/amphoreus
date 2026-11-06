// npm omits a root pnpm-lock.yaml. Carry the same public build lock under a publishable name.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const original=new URL('../pnpm-lock.yaml',import.meta.url),published=new URL('../source-lock.yaml',import.meta.url)
if(existsSync(original)){
 const bytes=readFileSync(original)
 if(!existsSync(published)||!readFileSync(published).equals(bytes))writeFileSync(published,bytes)
}else if(!existsSync(published))throw new Error('Missing build lockfile')
