/** The bundle's patch, read with the entry-list dialect DSH reads bundle patches with, and the agent preset it defines. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ROUTER_PRESET, WORKER_PRESET } from '../src/app/sessions.ts'
import { AmphoreusConfig } from '../src/amphoreus/config.ts'
import * as plugin from '../src/index.ts'

it('keeps the example configuration valid with explicit reasoning retention and nightly review defaults', () => {
  const config = AmphoreusConfig.parse(JSON.parse(readFileSync(new URL('../examples/amphoreus.json', import.meta.url), 'utf8')))
  expect(config.memory.timeZone).toBe('Asia/Shanghai')
  expect(config.memory.reasoning.allowedProviders).toEqual([])
  expect(config.memory.dreaming.at).toBe('01:00')
})

interface Row { id?: string; name: string; disabled?: unknown; config?: Record<string, unknown> & { plugins?: Row[] } | Row[] }
/** The patch as DSH reads it: Cordis's include plugin parses `!!js` scalars, and applies the inserts to an entry list. */
async function patched(): Promise<Row[]> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema, applyEntryPatches } = await import(include) as {
    entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const patches = yaml.load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as unknown[]
  const warnings: string[] = []
  const rows = applyEntryPatches([], patches, message => { warnings.push(message) })
  expect(warnings).toEqual([])
  return rows
}
/** Every plugin row of a preset, those inside groups too. */
const flat = (rows: readonly Row[]): Row[] => rows.flatMap(row => [row, ...Array.isArray(row.config) ? flat(row.config) : []])

/** A preset the patch defines, by its id. */
const presetOf = (rows: readonly Row[], id: string) => rows.map(row => row.config as { id?: string; order?: number; plugins: Row[] })
  .find(config => config?.id === id)!

it('ships one business bundle with scoped Deja and compatibility for existing native sessions', async () => {
  const root = join(import.meta.dirname, '..')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  expect(plugin.name).toBe('翁法罗斯')
  expect(manifest.name).toBe('@hosisora_ling/dsh-amphoreus')
  const rows = await patched()
  for (const role of ['worker', 'router']) {
    const current = presetOf(rows, `dsh-amphoreus-${role}`)
    const legacy = presetOf(rows, `dsh-superagent-${role}`)
    expect(legacy.plugins).toEqual(current.plugins)
  }
  // Every application plugin in the patch resolves inside this package; Deja needs no separate plugin install.
  for (const row of [...rows, ...rows.flatMap(row => flat((row.config as { plugins?: Row[] })?.plugins ?? []))]) {
    if (!row.name.startsWith('dsh-')) continue
    expect(row.name.split('/')[0]).toBe(manifest.name)
    const subpath = row.name.includes('/') ? `./${row.name.split('/').slice(1).join('/')}` : '.'
    expect(manifest.exports).toHaveProperty(subpath)
  }
  const entry = join(root, manifest.exports['./worker-deja'])
  const deja = await import(entry)
  expect(deja.default).toBeTypeOf('function')
  expect(deja.default.inject).toEqual(['tools', 'commands', 'systemPrompt'])
})

it('defines the worker preset Executor Sessions run under, with a shell that moves long commands to the background', async () => {
  const rows = await patched()
  expect(rows.map(row => row.id)).toEqual(['dsh-amphoreus', 'dsh-amphoreus-github', 'dsh-amphoreus-feishu', 'dsh-amphoreus-worker-preset',
    'dsh-amphoreus-router-preset', 'legacy-worker-preset', 'legacy-router-preset'])
  const preset = presetOf(rows, WORKER_PRESET)
  expect(preset.id).toBe(WORKER_PRESET)
  const plugins = flat(preset.plugins)
  const named = (name: string) => plugins.filter(row => row.name === name).map(row => row.config)
  expect(named('@deepseek-ai/dsh-bash-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-pwsh-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-tool-jobs')).toEqual([{ waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-tool-web')).toEqual([expect.objectContaining({ fetch: false })])
  // Spawned subagents run under standard, whose shell moves a command to the background only after 60 s; forked ones, which would run under
  // this preset, are left out.
  expect(named('@deepseek-ai/dsh-tool-subagent')).toEqual([expect.objectContaining({ provider: 'spawn', agentPreset: 'standard' })])
  // What a worker needs, and none of what asks a person, presents, plans, changes the profile, schedules, sets goals or runs workflows.
  for (const name of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-agent-instructions']) expect(named(name).length).toBeGreaterThan(0)
  const names = plugins.map(row => row.name)
  expect(names).toContain('@hosisora_ling/dsh-amphoreus/worker-deja')
  for (const name of ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-plugin-manager/tools',
    '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal',
    '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names).not.toContain(name)
})

it('defines the router preset the main Session runs under: the worker\'s 5-second shell and job waits, and only the tools it uses', async () => {
  const rows = await patched()
  const router = presetOf(rows, ROUTER_PRESET), worker = presetOf(rows, WORKER_PRESET)
  expect(router.order).toBe(91)
  const plugins = flat(router.plugins)
  const named = (preset: Row[], name: string) => preset.filter(row => row.name === name).map(row => row.config)
  for (const name of ['@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-jobs']) {
    expect(named(plugins, name), name).toEqual(named(flat(worker.plugins), name))
  }
  // The tools its allow list keeps: skill, bash, read, read_image and the job tools; the file tools only read.
  for (const name of ['@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner']) expect(named(plugins, name).length, name).toBeGreaterThan(0)
  expect(named(plugins, '@deepseek-ai/dsh-tool-fs')).toEqual([{ write: false, edit: false }])
  const names = plugins.map(row => row.name)
  expect(names).not.toContain('@hosisora_ling/dsh-amphoreus/worker-deja')
  for (const name of ['@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-plugin-manager/tools', '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names, name).not.toContain(name)
})
