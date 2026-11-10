import { expect, mock, test as testBase } from 'claude-code/testing'

// Par défaut, la session principale tourne sur Opus ; un test change `modele.nom` pour répondre autrement.
const modele = { nom: 'opus' }
const test: typeof testBase = ((nom: string, fn: any) =>
  testBase(nom, async ($: any, on: any) => {
    modele.nom = 'opus'
    on('session.model', () => ({ value: modele.nom }))
    return fn($, on)
  })) as any

const lancer = async (
  $: any,
  on: any,
  demande: { subagentType?: string; description: string; prompt: string; model?: string },
) => {
  let vu: string | undefined
  on('agent.spawn', (_: unknown, e: { model?: string }) => {
    vu = e.model
    return { model: e.model ?? 'parent' }
  })
  await $.agent.spawn({ subagentType: 'general-purpose', ...demande })
  return vu
}

const SANS_MODELE = 'cet appel ne donne pas de modèle, et c\'est à toi de le choisir'
const fond = (on: any) => on('agent.spawn', (_: unknown, e: { model?: string }) => ({ model: e.model ?? 'parent' }))
const spawn = ($: any, demande: Record<string, unknown> = {}) =>
  ($.agent.spawn as any)({ subagentType: 'general-purpose', description: 'Lister', prompt: 'Liste.', ...demande })

test('un agent sans modèle est refusé : c’est au cerveau de choisir', async ($, on) => {
  fond(on)
  const r = await spawn($)
  expect(r.deny).toContain(SANS_MODELE)
  expect(r.deny).toContain('`haiku`, `sonnet` ou `opus`')
  expect((await spawn($, { model: 'haiku' })).model).toBe('haiku')
})

test('un agent de l’équipe ou un agent léger n’a pas besoin de modèle dans l’appel', async ($, on) => {
  fond(on)
  expect((await spawn($, { subagentType: 'modeles:executant-sonnet' })).model).toBe('sonnet')
  expect((await spawn($, { subagentType: 'modeles:explorateur' })).model).toBe('haiku')
  expect((await spawn($, { subagentType: 'web-fetch' })).model).toBe('haiku')
})

test('un agent de l’équipe suit le modèle que le cerveau demande', async ($, on) => {
  fond(on)
  expect((await spawn($, { subagentType: 'modeles:executant-haiku', model: 'sonnet' })).model).toBe('sonnet')
  expect((await spawn($, { subagentType: 'modeles:relecteur', model: 'haiku' })).model).toBe('haiku')
  expect((await spawn($, { subagentType: 'modeles:relecteur', model: 'opus' })).model).toBe('opus')
  expect((await spawn($, { subagentType: 'modeles:relecteur', model: 'fable' })).model).toBe('opus')
})

test('un refus faute de modèle ne rouvre pas le budget direct', async ($, on) => {
  fond(on)
  on('tool.call', () => ({ result: {} }))
  const appel = () => ($.tool.call as any)({ tool: 'Read', file_path: '/projet/a.ts' })
  for (let i = 0; i < 5; i++) expect((await appel()).deny).toBeUndefined()
  expect((await spawn($)).deny).toContain(SANS_MODELE)
  expect((await appel()).deny).toContain('Mode manager')
})

const typeLance = async ($: any, on: any, demande: { description: string; prompt: string; model?: string }) => {
  let vu: string | undefined
  on('agent.spawn', (_: unknown, e: { model?: string; subagentType: string }) => {
    vu = e.subagentType
    return { model: e.model ?? 'parent' }
  })
  await $.agent.spawn({ subagentType: 'general-purpose', ...demande })
  return vu
}

test('general-purpose passe sur l’exécutant allégé du bon modèle', async ($, on) => {
  expect(await typeLance($, on, { description: 'Lister', prompt: 'Liste les fichiers.', model: 'haiku' })).toBe('modeles:executant-haiku')
})

test('une tâche confiée à Sonnet passe sur l’exécutant Sonnet', async ($, on) => {
  expect(await typeLance($, on, { description: 'Corriger', prompt: 'Corrige le bug.', model: 'sonnet' })).toBe('modeles:executant-sonnet')
})

test('une tâche qui nomme un MCP garde l’agent complet', async ($, on) => {
  expect(
    await typeLance($, on, { description: 'Lister', prompt: 'Liste les murs dans Archicad via Tapir.', model: 'haiku' }),
  ).toBe('general-purpose')
})

test('Explore passe sur l’explorateur', async ($, on) => {
  let vu: string | undefined
  on('agent.spawn', (_: unknown, e: { model?: string; subagentType: string }) => {
    vu = e.subagentType
    return { model: e.model ?? 'parent' }
  })
  await ($.agent.spawn as any)({ subagentType: 'Explore', description: 'Chercher', prompt: 'Cherche le parseur.' })
  expect(vu).toBe('modeles:explorateur')
})

test('le relecteur reste sur Sonnet même pour une lecture', async ($, on) => {
  expect(
    await lancer($, on, { subagentType: 'modeles:relecteur', description: 'Lire', prompt: 'Lis le fichier.' }),
  ).toBe('sonnet')
})

test('Opus fait lui-même une petite modification', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const r: any = await ($.tool.call as any)({ tool: 'Edit', file_path: '/projet/a.ts', old_string: 'a', new_string: 'b' })
  expect(r.deny).toBeUndefined()
})

test('Opus délègue une grosse modification', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const r: any = await ($.tool.call as any)({ tool: 'Edit', file_path: '/projet/a.ts', old_string: 'a', new_string: 'x'.repeat(601) })
  expect(r.deny).toContain('Mode manager')
})

test('Opus délègue l’écriture d’un gros fichier', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const r: any = await ($.tool.call as any)({ tool: 'Write', file_path: '/projet/a.ts', content: 'x'.repeat(601) })
  expect(r.deny).toContain('Mode manager')
})

test('une petite modification consomme le budget', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const edit = () => ($.tool.call as any)({ tool: 'Edit', file_path: '/projet/a.ts', old_string: 'a', new_string: 'b' })

  for (let i = 0; i < 5; i++) expect((await edit()).deny).toBeUndefined()
  expect((await edit()).deny).toContain('Mode manager')
})

test('Opus peut écrire ses notes dans ~/.claude', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const r: any = await ($.tool.call as any)({ tool: 'Write', file_path: '/Users/x/.claude/memory/a.md', content: 'a' })
  expect(r.deny).toBeUndefined()
})

test('un sous-agent peut modifier un fichier de projet', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const r: any = await ($.tool.call as any)({ tool: 'Edit', agentId: 'a1', file_path: '/projet/a.ts', old_string: 'a', new_string: 'x'.repeat(601) })
  expect(r.deny).toBeUndefined()
})

test('le sixième appel direct est refusé, un agent rouvre le budget', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', (_: unknown, e: { model?: string }) => ({ model: e.model ?? 'parent' }))
  const appel = () => ($.tool.call as any)({ tool: 'Read', file_path: '/projet/a.ts' })

  for (let i = 0; i < 5; i++) expect((await appel()).deny).toBeUndefined()
  expect((await appel()).deny).toContain('Mode manager')

  await ($.agent.spawn as any)({ subagentType: 'general-purpose', description: 'Lister', prompt: 'Liste.', model: 'haiku' })
  expect((await appel()).deny).toBeUndefined()
})

test('off lève les limites', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await ($.command.run as any)({ command: 'delegation', args: 'off' })
  const r: any = await ($.tool.call as any)({ tool: 'Edit', file_path: '/projet/a.ts', old_string: 'a', new_string: 'x'.repeat(601) })
  expect(r.deny).toBeUndefined()
})

test('un choix explicite de Sonnet est respecté, même pour une tâche simple', async ($, on) => {
  expect(await lancer($, on, { description: 'Lister', prompt: 'Liste les fichiers.', model: 'sonnet' })).toBe('sonnet')
})

test('un choix explicite de Haiku est respecté', async ($, on) => {
  expect(await lancer($, on, { description: 'Corriger', prompt: 'Corrige.', model: 'haiku' })).toBe('haiku')
})

test('sous Opus, un sous-agent Opus demandé par le cerveau est permis', async ($, on) => {
  expect(await lancer($, on, { description: 'Relire', prompt: 'Relis la migration.', model: 'opus' })).toBe('opus')
})

test('un agent de sécurité garde son modèle', async ($, on) => {
  expect(
    await lancer($, on, { subagentType: 'claude-security:scan-verifier', description: 'Vérifier', prompt: 'Vérifie.' }),
  ).toBeUndefined()
})

const MIN = 60_000
const appelOutil = ($: any, e: Record<string, unknown>) => ($.tool.call as any)(e)
const lire = ($: any) => appelOutil($, { tool: 'Read', file_path: '/projet/a.ts' })

test('un appel computer-use ouvre une fenêtre où les lectures ne comptent pas', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await appelOutil($, { tool: 'mcp__computer-use__screenshot' })
  for (let i = 0; i < 12; i++) {
    for (const tool of ['Read', 'Glob', 'Grep', 'Bash']) {
      expect((await appelOutil($, { tool, file_path: '/p/a', pattern: 'a', command: 'ls' })).deny).toBeUndefined()
    }
  }
})

test('hors fenêtre computer-use, le budget direct s’applique', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  for (let i = 0; i < 5; i++) expect((await lire($)).deny).toBeUndefined()
  expect((await lire($)).deny).toContain('Mode manager')
})

test('le budget s’applique à nouveau après la fenêtre de 10 minutes', async ($, on) => {
  const horloge = mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await appelOutil($, { tool: 'mcp__computer-use__screenshot' })
  await horloge.advance(10 * MIN - 1)
  for (let i = 0; i < 8; i++) expect((await lire($)).deny).toBeUndefined()
  await horloge.advance(2)
  for (let i = 0; i < 5; i++) expect((await lire($)).deny).toBeUndefined()
  expect((await lire($)).deny).toContain('Mode manager')
})

test('chaque appel computer-use renouvelle la fenêtre', async ($, on) => {
  const horloge = mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await appelOutil($, { tool: 'mcp__computer-use__screenshot' })
  await horloge.advance(9 * MIN)
  await appelOutil($, { tool: 'mcp__computer-use__left_click' })
  await horloge.advance(9 * MIN)
  for (let i = 0; i < 8; i++) expect((await lire($)).deny).toBeUndefined()
})

test('dans la fenêtre, les modifications restent comptées et limitées', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await appelOutil($, { tool: 'mcp__computer-use__screenshot' })
  const grosse = await appelOutil($, { tool: 'Edit', file_path: '/projet/a.ts', old_string: 'a', new_string: 'x'.repeat(601) })
  expect(grosse.deny).toContain('Mode manager')
  const edit = () => appelOutil($, { tool: 'Edit', file_path: '/projet/a.ts', old_string: 'a', new_string: 'b' })
  for (let i = 0; i < 5; i++) expect((await edit()).deny).toBeUndefined()
  expect((await edit()).deny).toContain('Mode manager')
})

const pas = ($: any, agentId: string | undefined, usage?: Record<string, number>) =>
  $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1, ...(agentId ? { agentId } : {}) })

// L'effort que chaque requête porte en arrivant sous le mod, dans l'ordre des requêtes.
const efforts: unknown[] = []

const etape = async ($: any, champs: Record<string, unknown> = {}) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1, ...champs })) void _
}

const preparer = (on: any, usage?: Record<string, number>) => {
  const vus: string[] = []
  efforts.length = 0
  on('ui.toast', (_: unknown, e: { text: string }) => {
    vus.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', (_: unknown, e: { model?: string; name?: string }) => ({ model: e.model ?? 'parent', agentId: e.name ?? 'a1' }))
  on('prompt.attachment', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number; effort?: unknown }) {
    efforts.push(e.effort)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usage
        ? { model: 'opus', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage }
        : null,
    }
  })
  return vus
}

const consommer = async ($: any, agentId: string | undefined, fois: number, usage?: Record<string, number>) => {
  for (let i = 0; i < fois; i++) {
    const flux = pas($, agentId)
    for await (const _ of flux) void _
  }
}

const lancerMembre = (
  $: any,
  type = 'modeles:executant-sonnet',
  name = 'a1',
) => ($.agent.spawn as any)({ subagentType: type, description: 'Tâche', prompt: 'Fais.', name })

const AVERTISSEMENT =
  'Avertissement : tu as fait 40 requêtes. Finis ton étape en cours et laisse les fichiers dans un état stable. Si ton travail est terminé ou peut s\'arrêter proprement, fais ton compte rendu maintenant : ce qui est fait, ce qui reste, l\'état des fichiers. Sinon, relance l\'appel refusé et continue, sans dépasser 80 requêtes.'
const lireAgent = ($: any, id = 'a1') => appelOutil($, { tool: 'Read', agentId: id, file_path: '/p/a' })

test('le premier appel après 40 requêtes est refusé avec l’avertissement, le suivant passe', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  await consommer($, 'a1', 39)
  expect((await lireAgent($)).deny).toBeUndefined()
  await consommer($, 'a1', 1)
  expect((await lireAgent($)).deny).toBe(AVERTISSEMENT)
  expect((await lireAgent($)).deny).toBeUndefined()
  expect((await lireAgent($)).deny).toBeUndefined()
})

test('SubagentHandback passe toujours et ne consomme pas l’avertissement', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  await consommer($, 'a1', 40)
  expect((await appelOutil($, { tool: 'SubagentHandback', agentId: 'a1', message: 'fini' })).deny).toBeUndefined()
  expect((await lireAgent($)).deny).toBe(AVERTISSEMENT)
  expect((await lireAgent($)).deny).toBeUndefined()
  await consommer($, 'a1', 40)
  expect((await appelOutil($, { tool: 'SubagentHandback', agentId: 'a1', message: 'fini' })).deny).toBeUndefined()
})

test('à 80 requêtes tout est refusé durablement, sauf SubagentHandback', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  await consommer($, 'a1', 79)
  expect((await lireAgent($)).deny).toBe(AVERTISSEMENT)
  expect((await lireAgent($)).deny).toBeUndefined()
  await consommer($, 'a1', 1)
  for (let i = 0; i < 3; i++) {
    const r = await lireAgent($)
    expect(r.deny).toContain('Limite atteinte')
    expect(r.deny).toContain('compte rendu')
  }
  expect((await appelOutil($, { tool: 'SubagentHandback', agentId: 'a1', message: 'fini' })).deny).toBeUndefined()
})

test('off lève l’avertissement et la limite', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  await consommer($, 'a1', 80)
  await ($.command.run as any)({ command: 'delegation', args: 'off' })
  expect((await lireAgent($)).deny).toBeUndefined()
  expect((await appelOutil($, { tool: 'SendMessage', to: 'a1', message: 'suite' })).deny).toBeUndefined()
})

test('un agent hors équipe n’est pas limité', async ($, on) => {
  preparer(on)
  await ($.agent.spawn as any)({ subagentType: 'claude-security:scan-verifier', description: 'V', prompt: 'V', name: 'b1' })
  await consommer($, 'b1', 85)
  const r = await appelOutil($, { tool: 'Read', agentId: 'b1', file_path: '/p/a' })
  expect(r.deny).toBeUndefined()
})

test('un autre membre n’est pas limité par le premier', async ($, on) => {
  preparer(on)
  await lancerMembre($, 'modeles:explorateur', 'a1')
  await lancerMembre($, 'modeles:relecteur', 'a2')
  await consommer($, 'a1', 80)
  expect((await appelOutil($, { tool: 'Read', agentId: 'a2', file_path: '/p/a' })).deny).toBeUndefined()
})

test('le fil principal refuse SendMessage vers un agent à 80 requêtes, pas à 40', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  await lancerMembre($, 'modeles:relecteur', 'a2')
  await consommer($, 'a1', 40)
  expect((await appelOutil($, { tool: 'SendMessage', to: 'a1', message: 'suite' })).deny).toBeUndefined()
  await consommer($, 'a1', 40)
  const r = await appelOutil($, { tool: 'SendMessage', to: 'a1', message: 'suite' })
  expect(r.deny).toContain('agent neuf')
  expect(r.deny).toContain('résumé')
  expect((await appelOutil($, { tool: 'SendMessage', to: 'a2', message: 'suite' })).deny).toBeUndefined()
  expect((await appelOutil($, { tool: 'SendMessage', to: 'main', message: 'suite' })).deny).toBeUndefined()
})

test('le fil principal fait ses appels même quand un agent est à la limite', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  await consommer($, 'a1', 80)
  expect((await lire($)).deny).toBeUndefined()
})

test('/delegation indique les agents avertis et arrêtés', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  await consommer($, 'a1', 40)
  let r: any = await ($.command.run as any)({ command: 'delegation', args: '' })
  expect(r.text).toContain('1 avertissement(s), 0 arrêt(s)')
  await consommer($, 'a1', 40)
  r = await ($.command.run as any)({ command: 'delegation', args: '' })
  expect(r.text).toContain('1 avertissement(s), 1 arrêt(s)')
})

test('/delegation donne le taux de cache, le coût et le forfait', async ($, on) => {
  preparer(on, { input_tokens: 100, cache_creation_input_tokens: 900, cache_read_input_tokens: 9_000 })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {},
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.5 },
        { kind: 'seven_day', percentUsed: 41 },
      ],
      cost: { usd: 1.234 },
    } as any,
  }))
  await consommer($, undefined, 1)
  const r: any = await ($.command.run as any)({ command: 'delegation', args: '' })
  expect(r.text).toContain('Cache : 90 % des tokens d\'entrée relus depuis le cache.')
  expect(r.text).toContain('Coût de la session, comme /cost : 1,23 $.')
  expect(r.text).toContain('Forfait consommé : 5 heures 23,5 % · 7 jours 41 %.')
})

test('/delegation se passe du coût et du forfait quand la session ne les donne pas', async ($, on) => {
  preparer(on)
  const r: any = await ($.command.run as any)({ command: 'delegation', args: '' })
  expect(r.text).toContain('Délégation active')
  expect(r.text).not.toContain('Forfait')
  expect(r.text).not.toContain('Cache :')
})

test('un agent allégé est limité comme un membre de l’équipe', async ($, on) => {
  preparer(on)
  await ($.agent.spawn as any)({ subagentType: 'general-purpose', description: 'Lister', prompt: 'Liste.', model: 'haiku', name: 'g1' })
  await consommer($, 'g1', 80)
  expect((await lireAgent($, 'g1')).deny).toContain('Limite atteinte')
})

const AVIS_CONTEXTE_DEBUT = 'Avertissement : ton contexte dépasse 70 000 tokens.'

test('un agent Haiku est averti à 70 000 tokens de contexte, puis arrêté à 95 000', async ($, on) => {
  const usage = { cache_read_input_tokens: 70_000 }
  preparer(on, usage)
  await lancerMembre($, 'modeles:explorateur')
  await etape($, { agentId: 'a1', model: 'claude-haiku-5-5' })
  expect((await lireAgent($)).deny).toBeUndefined()

  usage.cache_read_input_tokens = 70_001
  await etape($, { agentId: 'a1', model: 'claude-haiku-5-5' })
  expect((await lireAgent($)).deny).toContain(AVIS_CONTEXTE_DEBUT)
  expect((await lireAgent($)).deny).toBeUndefined()
  await etape($, { agentId: 'a1', model: 'claude-haiku-5-5' })
  expect((await lireAgent($)).deny).toBeUndefined()

  usage.cache_read_input_tokens = 95_001
  await etape($, { agentId: 'a1', model: 'claude-haiku-5-5' })
  for (let i = 0; i < 2; i++) {
    const r = await lireAgent($)
    expect(r.deny).toContain('Limite atteinte')
    expect(r.deny).toContain('95 000 tokens')
  }
  expect((await appelOutil($, { tool: 'SubagentHandback', agentId: 'a1', message: 'fini' })).deny).toBeUndefined()
  const suite = await appelOutil($, { tool: 'SendMessage', to: 'a1', message: 'suite' })
  expect(suite.deny).toContain('agent neuf')
  expect(suite.deny).toContain('95 000 tokens')
})

test('un agent Sonnet n’a pas de garde de contexte', async ($, on) => {
  preparer(on, { cache_read_input_tokens: 150_000 })
  await lancerMembre($)
  await etape($, { agentId: 'a1', model: 'claude-sonnet-5-5' })
  expect((await lireAgent($)).deny).toBeUndefined()
})

test('off lève la garde de contexte', async ($, on) => {
  preparer(on, { cache_read_input_tokens: 95_001 })
  await lancerMembre($, 'modeles:explorateur')
  await etape($, { agentId: 'a1', model: 'claude-haiku-5-5' })
  await ($.command.run as any)({ command: 'delegation', args: 'off' })
  expect((await lireAgent($)).deny).toBeUndefined()
})

test('le cerveau tourne en effort high par défaut, quel que soit le réglage de la session', async ($, on) => {
  preparer(on)
  await etape($, { effort: 'high' })
  await etape($, { effort: 'low' })
  await etape($, { effort: 'max' })
  await etape($, { effort: 'medium' })
  expect(efforts).toEqual(['high', 'high', 'high', 'high'])
})

test('un effort absent ou donné en nombre est laissé tel quel', async ($, on) => {
  preparer(on)
  await etape($)
  await etape($, { effort: 20_000 })
  expect(efforts).toEqual([undefined, 20_000])
})

test('/delegation effort change l’effort du cerveau et le retient pour les sessions suivantes', async ($, on) => {
  preparer(on)
  const ecrits: unknown[] = []
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    ecrits.push([e.key, e.value])
    return { value: undefined }
  })
  let r: any = await ($.command.run as any)({ command: 'delegation', args: 'effort max' })
  expect(r.text).toContain('Effort du cerveau : max')
  await etape($, { effort: 'medium' })
  r = await ($.command.run as any)({ command: 'delegation', args: 'effort session' })
  expect(r.text).toContain('celui de la session')
  await etape($, { effort: 'medium' })
  expect(efforts).toEqual(['max', 'medium'])
  expect(ecrits).toEqual([['effort', 'max'], ['effort', 'session']])
})

test('/delegation effort sans niveau, ou avec un niveau inconnu, dit le réglage et ne change rien', async ($, on) => {
  preparer(on)
  for (const args of ['effort', 'effort énorme']) {
    const r: any = await ($.command.run as any)({ command: 'delegation', args })
    expect(r.text).toContain('Effort du cerveau : high')
    expect(r.text).toContain('/delegation effort low, medium, high, xhigh ou max')
  }
  await etape($, { effort: 'low' })
  expect(efforts).toEqual(['high'])
})

test('off ne touche plus à l’effort', async ($, on) => {
  preparer(on)
  await ($.command.run as any)({ command: 'delegation', args: 'off' })
  await etape($, { effort: 'low' })
  expect(efforts).toEqual(['low'])
})

test('sur Sonnet, l’effort n’est pas touché', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-sonnet-5-5'
  await etape($, { model: 'claude-sonnet-5-5', effort: 'low' })
  expect(efforts).toEqual(['low'])
})

// Un appel Agent du cerveau tel que le moteur le déroule : l'appel d'outil, puis le lancement qui porte son tool_use_id.
const deleguer = async ($: any, id: string, demande: Record<string, unknown>) => {
  const { subagent_type = 'general-purpose', model, effort, name } = demande as Record<string, string | undefined>
  await appelOutil($, { tool: 'Agent', tool_use_id: id, description: 'Tâche', prompt: 'Fais.', subagent_type, model, effort, name })
  return ($.agent.spawn as any)({ subagentType: subagent_type, description: 'Tâche', prompt: 'Fais.', model, name, tool_use_id: id })
}

test('l’effort que le cerveau demande pour un agent de l’équipe est tenu', async ($, on) => {
  preparer(on)
  await deleguer($, 'tu1', { subagent_type: 'modeles:executant-sonnet', effort: 'high', name: 'e1' })
  await etape($, { agentId: 'e1', model: 'claude-sonnet-5-5', effort: 'medium' })
  await etape($, { agentId: 'e1', model: 'claude-sonnet-5-5', effort: 'high' })
  expect(efforts).toEqual(['high', 'high'])
})

test('l’effort que le cerveau demande pour un agent complet est tenu', async ($, on) => {
  preparer(on)
  await deleguer($, 'tu2', { model: 'haiku', effort: 'medium', name: 'm1' })
  await etape($, { agentId: 'm1', model: 'claude-haiku-5-5', effort: 'low' })
  expect(efforts).toEqual(['medium'])
})

test('sans effort demandé, l’effort de l’agent n’est pas touché', async ($, on) => {
  preparer(on)
  await deleguer($, 'tu3', { subagent_type: 'modeles:executant-sonnet', name: 'e1' })
  await deleguer($, 'tu4', { model: 'haiku', name: 'm1' })
  await etape($, { agentId: 'e1', model: 'claude-sonnet-5-5', effort: 'medium' })
  await etape($, { agentId: 'm1', model: 'claude-haiku-5-5', effort: 'high' })
  expect(efforts).toEqual(['medium', 'high'])
})

test('l’effort demandé pour un agent ne déborde pas sur le suivant', async ($, on) => {
  preparer(on)
  await deleguer($, 'tu5', { subagent_type: 'modeles:executant-sonnet', effort: 'max', name: 'e1' })
  await deleguer($, 'tu6', { subagent_type: 'modeles:executant-sonnet', name: 'e2' })
  await etape($, { agentId: 'e2', model: 'claude-sonnet-5-5', effort: 'medium' })
  await etape($, { agentId: 'e1', model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(efforts).toEqual(['medium', 'max'])
})

test('un agent de sécurité garde son effort', async ($, on) => {
  preparer(on)
  await ($.agent.spawn as any)({ subagentType: 'claude-security:scan-verifier', description: 'V', prompt: 'V', name: 'b1' })
  await etape($, { agentId: 'b1', model: 'opus', effort: 'high' })
  expect(efforts).toEqual(['high'])
})

test('/delegation compte les appels refusés faute de modèle', async ($, on) => {
  preparer(on)
  expect((await spawn($)).deny).toContain(SANS_MODELE)
  await spawn($, { model: 'haiku' })
  const r: any = await ($.command.run as any)({ command: 'delegation', args: '' })
  expect(r.text).toContain('Agents lancés : Haiku 1 · Sonnet 0 (1 allégé(s), 1 appel(s) refusé(s) faute de modèle')
})

const attache = ($: any, type: string, agentId?: string) =>
  $.prompt.attachment({ type, text: 'texte', origin: { kind: 'engine' }, ...(agentId ? { agentId } : {}) })

test('un membre de l’équipe perd les instructions MCP et la liste des outils différés', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  expect((await attache($, 'mcp_instructions_delta', 'a1')).text).toBeNull()
  expect((await attache($, 'deferred_tools_delta', 'a1')).text).toBeNull()
})

test('un membre garde les autres injections', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  expect((await attache($, 'todo_reminder', 'a1')).text).toBe('texte')
})

test('le fil principal garde ses injections MCP', async ($, on) => {
  preparer(on)
  await lancerMembre($)
  expect((await attache($, 'mcp_instructions_delta')).text).toBe('texte')
  expect((await attache($, 'deferred_tools_delta')).text).toBe('texte')
})

test('un agent hors équipe garde ses injections MCP', async ($, on) => {
  preparer(on)
  await ($.agent.spawn as any)({ subagentType: 'claude-security:scan-verifier', description: 'V', prompt: 'V', name: 'b1' })
  expect((await attache($, 'mcp_instructions_delta', 'b1')).text).toBe('texte')
})

test('un agent non identifiable garde ses injections MCP', async ($, on) => {
  preparer(on)
  expect((await attache($, 'mcp_instructions_delta', 'inconnu')).text).toBe('texte')
})

const toast = (seuil: string) =>
  `Contexte au-delà de ${seuil} tokens : la conversation sera compactée dès que la tâche en cours sera terminée.`
const CONSEIL_250 = toast('250 000')
const CONSEIL_500 = toast('500 000')

test('le conseil de compactage s’affiche une seule fois à 250 000 tokens, puis une fois à 500 000', async ($, on) => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 240_000 }
  const vus = preparer(on, usage)
  await consommer($, undefined, 3)
  expect(vus).toEqual([CONSEIL_250])
  usage.cache_read_input_tokens = 480_000
  await consommer($, undefined, 3)
  expect(vus).toEqual([CONSEIL_250, CONSEIL_500])
})

test('une session déjà au-delà de 500 000 tokens ne reçoit que le conseil le plus haut', async ($, on) => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 450_000 }
  const vus = preparer(on, usage)
  await consommer($, undefined, 2)
  usage.cache_read_input_tokens = 130_000
  await consommer($, undefined, 2)
  expect(vus).toEqual([CONSEIL_500])
})

test('pas de conseil sous 250 000 tokens', async ($, on) => {
  const vus = preparer(on, { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 229_990 })
  await consommer($, undefined, 2)
  expect(vus).toEqual([])
})

test('pas de conseil pour un sous-agent', async ($, on) => {
  const vus = preparer(on, { input_tokens: 300_000 })
  await consommer($, 'x9', 2)
  expect(vus).toEqual([])
})

let outilEnregistre: any
const demarrer = async ($: any, on: any, isInteractive: boolean, ecrans: string[] | 'erreur' = []) => {
  on('session.surfaces', () => {
    if (ecrans === 'erreur') throw new Error('lecture impossible')
    return { value: ecrans }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'delegation' } }))
  on('tool.register', (_: unknown, e: unknown) => {
    outilEnregistre = e
    return { value: { tool: 'mcp__modeles__compacter' } }
  })
  on('agent.register', (_: unknown, e: { name: string }) => ({ value: { agent: e.name } }))
  await $.session.start({ cwd: '/projet', surface: null, isInteractive })
}
const gros = ($: any) =>
  appelOutil($, { tool: 'Edit', file_path: '/projet/a.ts', old_string: 'a', new_string: 'x'.repeat(601) })
// Fable demandé en sous-agent : ramené à Opus quand le mode manager s'applique, laissé tel quel sinon.
const fableDemande = ($: any) =>
  ($.agent.spawn as any)({ subagentType: 'general-purpose', description: 'Lister', prompt: 'Liste.', model: 'fable', name: 'a1' })

test('claude -p sur Opus (non interactif, aucun écran) : aucune limite ni redirection', async ($, on) => {
  preparer(on)
  await demarrer($, on, false)
  expect((await gros($)).deny).toBeUndefined()
  for (let i = 0; i < 8; i++) expect((await lire($)).deny).toBeUndefined()
  expect((await fableDemande($)).model).toBe('fable')
  await consommer($, 'a1', 85)
  expect((await lireAgent($)).deny).toBeUndefined()
})

test('claude -p sur Opus : les injections MCP d’un membre restent', async ($, on) => {
  preparer(on)
  await demarrer($, on, false)
  await lancerMembre($)
  expect((await attache($, 'mcp_instructions_delta', 'a1')).text).toBe('texte')
})

test('session interactive sur Sonnet : aucune limite ni redirection', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-sonnet-5'
  await demarrer($, on, true)
  expect((await gros($)).deny).toBeUndefined()
  for (let i = 0; i < 8; i++) expect((await lire($)).deny).toBeUndefined()
  expect((await fableDemande($)).model).toBe('fable')
  await lancerMembre($)
  await consommer($, 'a1', 85)
  expect((await lireAgent($)).deny).toBeUndefined()
  expect((await attache($, 'mcp_instructions_delta', 'a1')).text).toBe('texte')
})

test('session interactive sur Opus : le mode manager s’applique', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-opus-4'
  await demarrer($, on, true)
  expect((await gros($)).deny).toContain('Mode manager')
  expect((await fableDemande($)).model).toBe('opus')
  await lancerMembre($)
  await consommer($, 'a1', 80)
  expect((await lireAgent($)).deny).toContain('Limite atteinte')
})

test('application de bureau sur Opus (isInteractive faux, écrans non vides) : le mode manager s’applique', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-opus-4'
  await demarrer($, on, false, ['desktop'])
  expect((await gros($)).deny).toContain('Mode manager')
  expect((await fableDemande($)).model).toBe('opus')
  await lancerMembre($)
  await consommer($, 'a1', 80)
  expect((await lireAgent($)).deny).toContain('Limite atteinte')
})

test('isInteractive faux, écrans vides puis écran attaché au tour suivant : le mode s’active', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-opus-4'
  const ecrans: string[] = []
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  await demarrer($, on, false, ecrans)
  expect((await gros($)).deny).toBeUndefined()
  ecrans.push('desktop')
  await ($.turn.start as any)({ turnId: 't2' })
  expect((await gros($)).deny).toContain('Mode manager')
})

test('isInteractive faux et lecture des écrans en erreur : on suppose un écran', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-opus-4'
  await demarrer($, on, false, 'erreur')
  expect((await gros($)).deny).toContain('Mode manager')
})

test('session interactive sur Fable : le mode manager s’applique', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-fable-5-2'
  await demarrer($, on, true)
  expect((await gros($)).deny).toContain('Mode manager')
  await etape($, { model: 'claude-fable-5-2', effort: 'low' })
  expect(efforts).toEqual(['high'])
  await lancerMembre($)
  await consommer($, 'a1', 80)
  expect((await lireAgent($)).deny).toContain('Limite atteinte')
})

test('sous Opus, Opus est permis en sous-agent et Fable est ramené à Opus', async ($, on) => {
  preparer(on)
  expect((await spawn($, { model: 'opus' })).model).toBe('opus')
  expect((await spawn($, { model: 'claude-opus-5-5' })).model).toBe('opus')
  expect((await spawn($, { model: 'fable' })).model).toBe('opus')
  expect((await spawn($, { model: 'claude-fable-5-2' })).model).toBe('opus')
  const r: any = await ($.command.run as any)({ command: 'delegation', args: '' })
  expect(r.text).toContain('Agents lancés : Haiku 0 · Sonnet 0 · Opus 4 · 2 rétrogradé(s)')
})

test('sous Fable, Opus et Fable sont permis en sous-agent', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-fable-5-2'
  expect((await spawn($, { model: 'opus' })).model).toBe('opus')
  expect((await spawn($, { model: 'fable' })).model).toBe('fable')
  expect((await spawn($, { model: 'claude-fable-5-2' })).model).toBe('fable')
  expect((await spawn($, { model: 'sonnet' })).model).toBe('sonnet')
  expect((await spawn($, { model: 'haiku' })).model).toBe('haiku')
  expect((await spawn($, { subagentType: 'modeles:relecteur', model: 'fable' })).model).toBe('fable')
  expect((await spawn($, { subagentType: 'modeles:relecteur' })).model).toBe('sonnet')
  const r: any = await ($.command.run as any)({ command: 'delegation', args: '' })
  expect(r.text).toContain('Agents lancés : Haiku 1 · Sonnet 2 · Opus 1 · Fable 3 (')
})

test('sous Fable, un agent général confié à Fable passe sur l’exécutant allégé, qui tourne sur Fable', async ($, on) => {
  modele.nom = 'claude-fable-5-2'
  let vu: { model?: string; subagentType?: string } = {}
  on('agent.spawn', (_: unknown, e: { model?: string; subagentType: string }) => {
    vu = e
    return { model: e.model ?? 'parent' }
  })
  await spawn($, { model: 'fable' })
  expect(vu.subagentType).toBe('modeles:executant-sonnet')
  expect(vu.model).toBe('fable')
})

test('sous Fable, le refus faute de modèle propose aussi Fable', async ($, on) => {
  fond(on)
  modele.nom = 'claude-fable-5-2'
  expect((await spawn($)).deny).toContain('`haiku`, `sonnet`, `opus` ou `fable`')
})

const reglesPour = async ($: any, on: any, model: string) => {
  on('prompt.compose', () => ({ sections: [] }))
  const r = await ($.prompt.compose as any)({ model, promptModel: model, surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })
  return (r.sections as { id: string; text: string }[]).find(s => s.id === 'modeles:regles')?.text
}

test('les règles du cerveau sous Opus : Opus permis en sous-agent, Fable ramené à Opus', async ($, on) => {
  const texte = await reglesPour($, on, 'claude-opus-5-5')
  expect(texte).toContain('(`haiku`, `sonnet` ou `opus`)')
  expect(texte).toContain('un agent demandé sur Fable est ramené à Opus')
  expect(texte).not.toContain('- Fable :')
  expect(texte).not.toContain('d\'Opus à Fable')
})

test('les règles du cerveau sous Fable : Fable permis pour ce qu’Opus ne fait pas bien', async ($, on) => {
  modele.nom = 'claude-fable-5-2'
  const texte = await reglesPour($, on, 'claude-fable-5-2')
  expect(texte).toContain('(`haiku`, `sonnet`, `opus` ou `fable`)')
  expect(texte).toContain('- Fable : même raisonnement un cran plus haut')
  expect(texte).toContain('de Sonnet à Opus, d\'Opus à Fable')
  expect(texte).not.toContain('ramené à Opus')
})

test('pas de règles du cerveau sur Sonnet', async ($, on) => {
  modele.nom = 'claude-sonnet-5-5'
  expect(await reglesPour($, on, 'claude-sonnet-5-5')).toBeUndefined()
})

test('un agent général confié à Opus passe sur l’exécutant allégé, qui tourne sur Opus', async ($, on) => {
  let vu: { model?: string; subagentType?: string } = {}
  on('agent.spawn', (_: unknown, e: { model?: string; subagentType: string }) => {
    vu = e
    return { model: e.model ?? 'parent' }
  })
  await spawn($, { model: 'opus' })
  expect(vu.subagentType).toBe('modeles:executant-sonnet')
  expect(vu.model).toBe('opus')
})

test('un effort du cerveau retenu est repris au démarrage de la session', async ($, on) => {
  preparer(on)
  on('store.get', (_: unknown, e: { key: string }) => ({ value: e.key === 'effort' ? 'max' : undefined }))
  await demarrer($, on, true)
  await etape($, { effort: 'low' })
  expect(efforts).toEqual(['max'])
})

test('un agent lancé par un autre agent, sans modèle, va sur Sonnet', async ($, on) => {
  fond(on)
  expect((await spawn($, { parentAgentId: 'p1' })).model).toBe('sonnet')
})

test('application de bureau sur Sonnet : aucune limite', async ($, on) => {
  preparer(on)
  modele.nom = 'claude-sonnet-5'
  await demarrer($, on, false, ['desktop'])
  expect((await gros($)).deny).toBeUndefined()
})

// --- Compactage demandé par le cerveau ---

const OUTIL = 'mcp__modeles__compacter'
const DELAI = 1500
const USAGE_GROS = { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 280_000 }
const RESUME = [{ role: 'user', text: 'Résumé', toolUses: [] }] as any
const NOTE_ATTENTE = 'Compactage noté : il se fera dès que le tour en cours et les agents auront fini.'
const GARDE = 'Garde le plan et les fichiers touchés'

const demander = ($: any, a_garder: unknown = GARDE) => appelOutil($, { tool: OUTIL, a_garder })
const finDeTour = ($: any, champs: Record<string, unknown> = {}) =>
  $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', ...champs })

// Le décor commun : session démarrée, horloge simulée, compactage réussi (300k -> 40k) ; renvoie les appels à compact.
const agents = { liste: [] as { id: string; type: string; status: string }[] }
const decorCompactage = async ($: any, on: any, resultat: () => unknown = () => ({ messages: RESUME, tokensBefore: 300_000, tokensAfter: 40_000 }), usage?: Record<string, number>) => {
  agents.liste = []
  const vus = preparer(on, usage)
  const compactages: { instructions?: string }[] = []
  const horloge = mock.clock(on)
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: agents.liste }) as any)
  on('prompt.submit', (_: unknown, e: { text: string; context?: string[] }) => ({ text: e.text, context: e.context }))
  on('session.compact', (_: unknown, e: { instructions?: string }) => {
    compactages.push({ instructions: e.instructions })
    return resultat() as any
  })
  await demarrer($, on, true)
  return { vus, compactages, horloge }
}

const soumettre = async ($: any, champs: Record<string, unknown> = {}) =>
  ($.prompt.submit as any)({ text: 'suite', wait: false, ...champs })

test('session.start enregistre l’outil compacter, toujours chargé, avec a_garder obligatoire', async ($, on) => {
  await decorCompactage($, on)
  expect(outilEnregistre.name).toBe('compacter')
  expect(outilEnregistre.isDeferred).toBe(false)
  expect(outilEnregistre.inputSchema.required).toEqual(['a_garder'])
})

test('l’outil refuse un appel sans a_garder, un a_garder d’espaces et un appel venu d’un agent', async ($, on) => {
  await decorCompactage($, on)
  expect((await appelOutil($, { tool: OUTIL })).deny).toContain('a_garder')
  expect((await demander($, '   \n ')).deny).toContain('a_garder')
  expect((await appelOutil($, { tool: OUTIL, agentId: 'a1', a_garder: GARDE })).deny).toContain('fil principal')
})

test('l’outil accepte un appel correct', async ($, on) => {
  await decorCompactage($, on)
  const r = await demander($)
  expect(r.deny).toBeUndefined()
  expect(r.result).toContain('Compactage noté')
})

test('après une demande, la fin du tour puis 1 500 ms lancent le compactage et l’annoncent', async ($, on) => {
  const { vus, compactages, horloge } = await decorCompactage($, on)
  await demander($)
  await finDeTour($)
  await horloge.advance(DELAI)
  expect(compactages).toEqual([{ instructions: GARDE }])
  expect(vus).toContain('Conversation compactée : 300k → 40k tokens.')
  expect(((await ($.command.run as any)({ command: 'delegation', args: '' })).text)).toContain('1 compactage(s)')
})

test('sans demande, rien n’est compacté', async ($, on) => {
  const { compactages, horloge } = await decorCompactage($, on)
  await finDeTour($)
  await horloge.advance(DELAI * 2)
  expect(compactages).toEqual([])
})

test('avant la fin du délai, rien n’est compacté', async ($, on) => {
  const { compactages, horloge } = await decorCompactage($, on)
  await demander($)
  await finDeTour($)
  await horloge.advance(DELAI - 1)
  expect(compactages).toEqual([])
})

test('un tour interrompu ne déclenche pas le compactage', async ($, on) => {
  const { compactages, horloge } = await decorCompactage($, on)
  await demander($)
  await finDeTour($, { reason: 'aborted', isAborted: true })
  await horloge.advance(DELAI * 2)
  expect(compactages).toEqual([])
})

test('un agent encore en route retarde le compactage, qui se fait à la fin du tour suivant', async ($, on) => {
  const { compactages, horloge } = await decorCompactage($, on)
  agents.liste = [{ id: 'a1', type: 'general-purpose', status: 'running' }]
  await demander($)
  await finDeTour($)
  await horloge.advance(DELAI)
  expect(compactages).toEqual([])
  agents.liste[0]!.status = 'completed'
  await finDeTour($)
  await horloge.advance(DELAI)
  expect(compactages).toHaveLength(1)
})

test('si le compactage échoue, la demande reste et il est retenté à la fin du tour suivant', async ($, on) => {
  let echec = true
  const { compactages, horloge } = await decorCompactage($, on, () => {
    if (echec) throw new Error('tour en cours')
    return { messages: RESUME, tokensBefore: 300_000, tokensAfter: 40_000 }
  })
  await demander($)
  await finDeTour($)
  await horloge.advance(DELAI)
  expect(compactages).toHaveLength(1)
  echec = false
  await finDeTour($)
  await horloge.advance(DELAI)
  expect(compactages).toHaveLength(2)
  expect(compactages[1]!.instructions).toBe(GARDE)
})

test('sur skip, le toast donne la raison et aucun nouvel essai n’a lieu', async ($, on) => {
  const { vus, compactages, horloge } = await decorCompactage($, on, () => ({ skip: 'refusé' }))
  await demander($)
  await finDeTour($)
  await horloge.advance(DELAI)
  expect(vus).toContain('Compactage non fait : refusé')
  await finDeTour($)
  await horloge.advance(DELAI)
  expect(compactages).toHaveLength(1)
})

test('au-delà de 250 000 tokens, le rappel part une fois avec le prompt suivant', async ($, on) => {
  const { vus } = await decorCompactage($, on, undefined, USAGE_GROS)
  await consommer($, undefined, 1)
  expect(vus).toContain(CONSEIL_250)
  const r: any = await soumettre($)
  expect(r.context).toHaveLength(1)
  expect(r.context[0]).toContain('dépasse 250 000 tokens')
  expect(r.context[0]).toContain(OUTIL)
  expect(((await soumettre($)) as any).context ?? []).toEqual([])
})

test('une commande slash ne consomme pas le rappel, le prompt suivant le reçoit', async ($, on) => {
  await decorCompactage($, on, undefined, USAGE_GROS)
  await consommer($, undefined, 1)
  const commande: any = await soumettre($, { text: '/status', command: { name: 'status', args: '' } })
  expect(commande.context ?? []).toEqual([])
  const suivant: any = await soumettre($)
  expect(suivant.context[0]).toContain('dépasse 250 000 tokens')
})

test('après un compactage réussi, un nouveau franchissement de 250 000 redonne le toast', async ($, on) => {
  const { vus, horloge } = await decorCompactage($, on, undefined, USAGE_GROS)
  await consommer($, undefined, 1)
  await demander($)
  await finDeTour($)
  await horloge.advance(DELAI)
  await consommer($, undefined, 1)
  expect(vus.filter(t => t === CONSEIL_250)).toHaveLength(2)
})

test('/delegation compacter avec un texte le passe tel quel, sans texte la consigne par défaut', async ($, on) => {
  const { compactages, horloge } = await decorCompactage($, on)
  const r = await ($.command.run as any)({ command: 'delegation', args: 'compacter Garde le Plan B' })
  expect(r.text).toBe(NOTE_ATTENTE)
  await horloge.advance(DELAI)
  await ($.command.run as any)({ command: 'delegation', args: 'compacter' })
  await horloge.advance(DELAI)
  expect(compactages[0]!.instructions).toBe('Garde le Plan B')
  expect(compactages[1]!.instructions).toContain('Garde les décisions prises')
})

test('/delegation compacter répond « noté » et lance le compactage 1 500 ms plus tard, retenté si rejeté', async ($, on) => {
  let echec = true
  const { compactages, horloge } = await decorCompactage($, on, () => {
    if (echec) throw new Error('tour en cours')
    return { messages: RESUME, tokensBefore: 300_000, tokensAfter: 40_000 }
  })
  const r = await ($.command.run as any)({ command: 'delegation', args: 'compacter' })
  expect(r.text).toBe(NOTE_ATTENTE)
  expect(compactages).toHaveLength(0)
  await horloge.advance(DELAI)
  expect(compactages).toHaveLength(1)
  echec = false
  await finDeTour($)
  await horloge.advance(DELAI)
  expect(compactages).toHaveLength(2)
})

test('sur Sonnet, le mode manager est inactif : ni toast ni rappel au-delà de 250 000 tokens', async ($, on) => {
  modele.nom = 'claude-sonnet-5'
  const { vus } = await decorCompactage($, on, undefined, USAGE_GROS)
  await consommer($, undefined, 1)
  expect(vus).toEqual([])
  expect(((await soumettre($)) as any).context ?? []).toEqual([])
})
