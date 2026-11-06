#!/usr/bin/env node
// dsh-deja 0.23.3 recognizes human prompts only. Delegated worker tasks keep
// their honest producer attribution but must also trigger the same native hook.
import { readFileSync, writeFileSync } from 'node:fs'
const [input, output] = process.argv.slice(2)
if (!input || !output || input === output) throw new Error('Usage: prepare-worker-deja.mjs INSTALLED_INDEX NEW_WORKER_INDEX')
const source = readFileSync(input, 'utf8')
const before = '(!message.source || message.source.kind === "user")'
if (source.split(before).length !== 2) throw new Error('Unsupported dsh-deja source; review the worker compatibility patch before upgrading')
writeFileSync(output, source.replace(before, '(!message.source || message.source.kind === "user" || message.source.kind === "dsh-amphoreus")'), { mode: 0o644, flag: 'wx' })
