import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'
const root = resolve(import.meta.dirname, '..')
it('keeps public documentation links attached to shipped files', () => {
  const documents = ['README.md', 'SETUP.md', ...readdirSync(resolve(root,'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)]
  const missing = documents.flatMap(name => {
    const file = resolve(root,name), text = readFileSync(file,'utf8')
    return [...text.matchAll(/\]\(([^)\s]+)\)/g)].flatMap(match => {
      const link = match[1]!.split('#')[0]!
      return !link || /^[a-z]+:/i.test(link) || existsSync(resolve(dirname(file),link)) ? [] : [`${name}: ${link}`]
    })
  })
  expect(missing).toEqual([])
})
