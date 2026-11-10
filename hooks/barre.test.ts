import { expect, test } from 'claude-code/testing'

const liste = { agents: [] as { id: string; status: string }[] }
const textes: string[] = []

const preparer = (on: any, agents: { id: string; status: string }[] = []) => {
  liste.agents = agents
  textes.length = 0
  on('ui.status', (_: unknown, e: { text?: string }) => {
    textes.push(e.text as string)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'delegation' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__modeles__compacter' } }))
  on('agent.register', (_: unknown, e: { name: string }) => ({ value: { agent: e.name } }))
  on('agent.list', () => ({ value: liste.agents }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
}

const demarrer = ($: any) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
const pas = async ($: any, model: string, agentId?: string) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })) void _
}
const fin = ($: any, agentId?: string) =>
  $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, ...(agentId ? { agentId } : {}) })

const REPOS = 'Opus · Sonnet · Haiku'

test('au repos, les trois noms sans pastille', async ($, on) => {
  preparer(on)
  await demarrer($)
  expect(textes).toEqual([REPOS])
})

test('pendant une requête Opus, seul Opus est marqué', async ($, on) => {
  preparer(on)
  await demarrer($)
  await pas($, 'claude-opus-4-1')
  expect(textes.at(-1)).toBe('🟢 Opus · Sonnet · Haiku')
})

test('avec un agent Haiku actif, Opus et Haiku sont marqués', async ($, on) => {
  preparer(on, [{ id: 'a1', status: 'running' }])
  await demarrer($)
  await pas($, 'claude-opus-4-1')
  await pas($, 'claude-haiku-4-5', 'a1')
  expect(textes.at(-1)).toBe('🟢 Opus · Sonnet · 🟢 Haiku')
})

test('après turn.complete, la marque s\'éteint', async ($, on) => {
  preparer(on, [{ id: 'a1', status: 'running' }])
  await demarrer($)
  await pas($, 'claude-opus-4-1')
  await pas($, 'claude-haiku-4-5', 'a1')
  await fin($, 'a1')
  expect(textes.at(-1)).toBe('🟢 Opus · Sonnet · Haiku')
  await fin($)
  expect(textes.at(-1)).toBe(REPOS)
})

test('un agent disparu de la liste ou terminé est retiré', async ($, on) => {
  preparer(on, [{ id: 'a1', status: 'running' }, { id: 'a2', status: 'running' }])
  await demarrer($)
  await pas($, 'claude-haiku-4-5', 'a1')
  expect(textes.at(-1)).toBe('Opus · Sonnet · 🟢 Haiku')
  liste.agents = [{ id: 'a2', status: 'running' }]
  await pas($, 'claude-sonnet-4-5', 'a2')
  expect(textes.at(-1)).toBe('Opus · 🟢 Sonnet · Haiku')
  liste.agents = [{ id: 'a2', status: 'completed' }]
  await pas($, 'claude-opus-4-1')
  expect(textes.at(-1)).toBe('🟢 Opus · Sonnet · Haiku')
})

test('sur Fable, le premier nom est Fable dès le démarrage', async ($, on) => {
  preparer(on)
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  await demarrer($)
  expect(textes).toEqual(['Fable · Opus · Sonnet · Haiku'])
  await pas($, 'claude-fable-5-2')
  await pas($, 'claude-haiku-5-5', 'a1')
  expect(textes.at(-1)).toBe('🟢 Fable · Opus · Sonnet · 🟢 Haiku')
})

test('sur Fable, un sous-agent Opus actif est marqué', async ($, on) => {
  preparer(on, [{ id: 'a1', status: 'running' }])
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  await demarrer($)
  await pas($, 'claude-fable-5-2')
  await pas($, 'claude-opus-5-5', 'a1')
  expect(textes.at(-1)).toBe('🟢 Fable · 🟢 Opus · Sonnet · Haiku')
})

test('le premier nom suit le modèle du fil principal quand il change', async ($, on) => {
  preparer(on)
  await demarrer($)
  await pas($, 'claude-fable-5-2')
  expect(textes.at(-1)).toBe('🟢 Fable · Opus · Sonnet · Haiku')
  await pas($, 'claude-opus-5-5')
  expect(textes.at(-1)).toBe('🟢 Opus · Sonnet · Haiku')
})

test('session.start vide tout', async ($, on) => {
  preparer(on)
  await demarrer($)
  await pas($, 'claude-opus-4-1')
  await demarrer($)
  expect(textes.at(-1)).toBe(REPOS)
})

test('aucun appel quand le texte ne change pas', async ($, on) => {
  preparer(on)
  await demarrer($)
  await pas($, 'claude-opus-4-1')
  await pas($, 'claude-opus-4-1')
  await fin($)
  await fin($)
  expect(textes).toEqual([REPOS, '🟢 Opus · Sonnet · Haiku', REPOS])
})
