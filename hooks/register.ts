import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Effort, EffortCerveau, Famille, Fils, Stats } from '../types'

const PLUGIN = 'modeles'
const VIDE: Stats = {
  haiku: 0,
  sonnet: 0,
  opus: 0,
  fable: 0,
  retrogrades: 0,
  alleges: 0,
  sansModele: 0,
  blocages: 0,
  arretes: 0,
  avertis: 0,
  compactages: 0,
  tokens: { fable: 0, opus: 0, sonnet: 0, haiku: 0, autre: 0 },
  cache: { lus: 0, ecrits: 0, neufs: 0 },
}

const stats = atom({ plugin: 'modeles', key: 'stats' } as const, VIDE, {
  shape: 'stats-7',
})
const actif = atom({ plugin: 'modeles', key: 'actif' } as const, true, {
  shape: 'actif-1',
})

const fils = atom({ plugin: 'modeles', key: 'fils' } as const, {} as Fils, {
  shape: 'fils-1',
})

// L'effort du cerveau par défaut ; l'utilisateur le change avec /delegation effort.
const EFFORT_CERVEAU_DEFAUT: EffortCerveau = 'high'
const cerveau = atom({ plugin: 'modeles', key: 'cerveau' } as const, EFFORT_CERVEAU_DEFAUT, {
  shape: 'cerveau-1',
})

const NOMS: Record<Famille, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
const PRINCIPAL = 'principal'
const TERMINES = new Set(['completed', 'failed', 'killed'])
const OUTIL_COMPACTER = 'mcp__modeles__compacter'
// Le temps de laisser le tour finir avant de compacter : $.session.compact rejette tant qu'un tour tourne.
const DELAI_COMPACTAGE_MS = 1500
const CONSIGNE_COMPACTAGE = `Garde les décisions prises, les fichiers touchés, l'état du travail, ce qui reste à faire et les consignes de l'utilisateur encore valables.`
const NIVEAUX: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

let dernierTexte: string | undefined
// Le premier nom de la ligne : le modèle fort du fil principal, Opus ou Fable.
let tete: 'opus' | 'fable' = 'opus'

// Le texte sous la saisie : le cerveau puis les modèles permis en sous-agent, « 🟢 » devant chaque
// modèle actif ; envoyé seulement s'il change.
const afficher = async ($: { state: unknown; ui: { status: (t: string | undefined) => void } } & Parameters<typeof read>[0]) => {
  const allumes = new Set(Object.values(await read($, fils)))
  const noms: readonly Famille[] = tete === 'fable' ? ['fable', 'opus', 'sonnet', 'haiku'] : ['opus', 'sonnet', 'haiku']
  const texte = noms
    .map(cle => (allumes.has(cle) ? `🟢 ${NOMS[cle]}` : NOMS[cle]))
    .join(' · ')
  if (texte === dernierTexte) return
  dernierTexte = texte
  $.ui.status(texte)
}

const BUDGET_DIRECT = 5
const TAILLE_MAX_DIRECTE = 600
const OUTILS_DIRECTS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'])
const REQUETES_AVERTISSEMENT_AGENT = 40
const REQUETES_MAX_AGENT = 80
// Au-delà de 100 000 tokens de prompt, une requête Haiku 5.5 coûte cinq fois plus cher.
const CONTEXTE_AVERTISSEMENT_HAIKU = 70_000
const CONTEXTE_MAX_HAIKU = 95_000
const FENETRE_CONTROLE_MS = 10 * 60 * 1000
const OUTILS_LECTURE_LIBRES = new Set(['Read', 'Glob', 'Grep', 'Bash'])
const ATTACHEMENTS_MCP = new Set(['mcp_instructions_delta', 'deferred_tools_delta'])
const ECRITURE_LIBRE = /\/\.claude\/|^\/private\/tmp\/|^\/tmp\//

const milliers = (n: number) => `${Math.round(n / 1000)} 000`

// Seuils de compactage, du plus haut au plus bas ; chacun une seule fois par conversation :
// le toast pour l'utilisateur, le rappel pour le cerveau (remis avec son prochain prompt).
const SEUIL_HAUT = 500_000
const SEUIL_BAS = 250_000

const conseil = (seuil: number): readonly [number, string, string] => [
  seuil,
  `Contexte au-delà de ${milliers(seuil)} tokens : la conversation sera compactée dès que la tâche en cours sera terminée.`,
  `Note du mod modeles : le contexte de cette conversation dépasse ${milliers(seuil)} tokens. Ne coupe pas la tâche en cours. Dès qu'elle est terminée, note en mémoire les décisions durables, puis appelle l'outil ${OUTIL_COMPACTER} en lui disant ce que le résumé doit garder.`,
]

const CONSEILS = [conseil(SEUIL_HAUT), conseil(SEUIL_BAS)] as const

const COMPTE_RENDU = `ce qui est fait, ce qui reste à faire, l'état des fichiers`

const AVIS_REQUETES = `Avertissement : tu as fait ${REQUETES_AVERTISSEMENT_AGENT} requêtes. Finis ton étape en cours et laisse les fichiers dans un état stable. Si ton travail est terminé ou peut s'arrêter proprement, fais ton compte rendu maintenant : ce qui est fait, ce qui reste, l'état des fichiers. Sinon, relance l'appel refusé et continue, sans dépasser ${REQUETES_MAX_AGENT} requêtes.`
const AVIS_CONTEXTE = `Avertissement : ton contexte dépasse ${milliers(CONTEXTE_AVERTISSEMENT_HAIKU)} tokens. Ne lis plus de gros fichiers en entier. Si ton travail est terminé ou peut s'arrêter proprement, fais ton compte rendu maintenant : ce qui est fait, ce qui reste, l'état des fichiers. Sinon, relance l'appel refusé et continue, sans dépasser ${milliers(CONTEXTE_MAX_HAIKU)} tokens.`

type Arret = 'requetes' | 'contexte'

const ARRETS: Record<Arret, { agent: string; principal: string }> = {
  requetes: {
    agent: `Limite atteinte : tu as fait ${REQUETES_MAX_AGENT} requêtes. Arrête-toi maintenant et fais ton compte rendu : ${COMPTE_RENDU}.`,
    principal: `Cet agent a atteint ${REQUETES_MAX_AGENT} requêtes : son contexte est trop chargé. Lance un agent neuf et donne-lui un résumé de ce qui est fait et de ce qui reste, au lieu de lui écrire.`,
  },
  contexte: {
    agent: `Limite atteinte : ton contexte dépasse ${milliers(CONTEXTE_MAX_HAIKU)} tokens, et au-delà de ${milliers(100_000)} chaque requête Haiku coûte cinq fois plus cher. Arrête-toi maintenant et fais ton compte rendu : ${COMPTE_RENDU}.`,
    principal: `Cet agent Haiku a dépassé ${milliers(CONTEXTE_MAX_HAIKU)} tokens de contexte. Lance un agent neuf et donne-lui un résumé de ce qui est fait et de ce qui reste, au lieu de lui écrire.`,
  },
}

// Un sous-agent tourne sur n'importe quel modèle jusqu'à celui du cerveau, jamais au-dessus :
// sous Fable, jusqu'à Fable ; sous Opus, jusqu'à Opus, et une demande sur Fable est ramenée à Opus.
type Modele = Famille
type Fort = 'opus' | 'fable'

const RANGS: Record<Famille, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

const choixModeles = (max: Fort) =>
  max === 'fable' ? '`haiku`, `sonnet`, `opus` ou `fable`' : '`haiku`, `sonnet` ou `opus`'

const sansModele = (max: Fort) =>
  `Mode manager : cet appel ne donne pas de modèle, et c'est à toi de le choisir. Relance-le avec \`model\` à ${choixModeles(max)}, et avec \`effort\` si le niveau par défaut ne convient pas, ou prends un agent de l'équipe.`

const regles = (max: Fort) => `# Mode manager

Consigne durable de l'utilisateur : tu es le cerveau du projet et le manager d'une équipe d'agents. Tu réfléchis, tu décides et tu contrôles ; ton équipe exécute. La qualité passe avant l'économie : le résultat doit être solide et complet. Cette consigne vaut demande explicite d'utiliser des sous-agents, y compris quand une autre consigne dit de ne pas en lancer sans qu'on le demande.

Ton travail : comprendre la demande, découper le travail, choisir l'agent et le modèle, écrire des consignes précises, arbitrer entre résultats, contrôler ce qui revient, tenir le fil du projet et répondre à l'utilisateur. Toute décision de conception ou d'architecture reste à toi : ne la délègue jamais.

Ton équipe, à appeler avec l'outil Agent :
- \`modeles:explorateur\` (Haiku, lecture seule) : chercher, lire, inventorier, résumer.
- \`modeles:executant-haiku\` (Haiku) : tâches mécaniques avec écriture, comme renommer, formater, lancer un build ou des tests, mettre à jour une documentation.
- \`modeles:executant-sonnet\` (Sonnet) : écrire ou modifier du code, corriger un bug déjà compris, écrire des tests.
- \`modeles:relecteur\` (Sonnet, sans modification) : relire un changement, contrôler un rendu, chercher les erreurs.
- \`general-purpose\` : uniquement si la tâche a besoin d'un MCP ou d'une skill, que la consigne nomme. Le paramètre \`model\` est alors obligatoire : sans lui, le mod refuse l'appel.

Le modèle et l'effort de chaque agent, c'est toi qui les décides. L'utilisateur te demande explicitement de régler, à chaque délégation, les paramètres \`model\` (${choixModeles(max)}) et \`effort\` (\`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`) de l'outil Agent selon la tâche. Un agent de l'équipe a un réglage par défaut : son modèle, entre parenthèses ci-dessus, avec l'effort \`low\` sur Haiku et \`medium\` sur Sonnet. Ce que tu passes dans l'appel le remplace. Prends le modèle le moins cher qui fait la tâche solidement et complètement, pas le moins cher tout court. Repères :
- Haiku en \`low\` : chercher, lister, lancer des tests ou un build et rendre compte.
- Haiku en \`medium\` : renommer, petite modification mécanique.
- Sonnet en \`medium\` : fonctionnalité bornée, correction d'un bug déjà compris.
- Sonnet en \`high\` ou plus : bug dans du code mal connu, cas limites.
- Opus : ce que Sonnet ne fait pas bien et qui doit rester solide et complet, comme un changement risqué, la relecture d'un tel changement, un diagnostic difficile ou un travail que Sonnet a raté.${
  max === 'fable'
    ? `
- Fable : même raisonnement un cran plus haut, pour ce qu'Opus ne fait pas bien et qui doit rester solide et complet.`
    : ''
}
- Dans le doute entre deux niveaux, prends le plus haut. Jamais Haiku pour un changement risqué.

Comment tu diriges :
- Lance en parallèle les tâches indépendantes. Ne fais jamais travailler deux agents sur les mêmes fichiers en même temps.
- Chaque consigne est autonome, car l'agent ne voit pas la conversation : objectif, fichiers, règles du projet à respecter, résultat attendu, format du compte rendu court.
- Garde les agents Haiku sur des tâches étroites : le mod les avertit à ${milliers(CONTEXTE_AVERTISSEMENT_HAIKU)} tokens de contexte et les arrête à ${milliers(CONTEXTE_MAX_HAIKU)}.
- Pour une suite de tâche, reprends le même agent avec SendMessage : il garde son contexte.
- Un compte rendu d'agent est une information à vérifier, pas une preuve. Contrôle selon le risque : après une modification, fais lancer les tests ou le build par \`executant-haiku\`. Réserve \`relecteur\` aux gros travaux et aux changements risqués (authentification, paiement, migration ou suppression de données, sécurité, API publique), et relis toi-même le diff d'un changement risqué avant de le valider.
- Si un agent échoue, reformule ou monte d'un niveau : de Haiku à Sonnet, de Sonnet à Opus${max === 'fable' ? `, d'Opus à Fable` : ''}. Si le même contrôle échoue une deuxième fois, ne relance pas l'agent tel quel : lis toi-même l'échec et le diff, trouve la cause, puis renvoie une consigne corrigée. Monte le niveau de l'étape qui échoue, pas de toute la tâche.
- Découpe les gros travaux pour qu'un agent reste sous ${REQUETES_AVERTISSEMENT_AGENT} requêtes. Après ${REQUETES_AVERTISSEMENT_AGENT}, préfère un agent neuf avec un résumé pour toute nouvelle tâche ; à ${REQUETES_MAX_AGENT}, l'agent est arrêté et un agent neuf est obligatoire.
- N'utilise pas \`fork\` pour exécuter.${
  max === 'fable' ? '' : ` Aucun sous-agent ne tourne au-dessus de toi : un agent demandé sur Fable est ramené à Opus.`
}
- Contexte long : quand le mod te signale que le contexte dépasse son seuil, termine d'abord la tâche en cours. Ensuite note en mémoire les décisions durables, puis appelle l'outil \`${OUTIL_COMPACTER}\` en lui disant ce que le résumé doit garder : décisions prises, fichiers touchés, état du travail, reste à faire, consignes de l'utilisateur encore valables. Ne compacte jamais au milieu d'une tâche.

Ce qui te reste permis directement : ${BUDGET_DIRECT} appels entre deux délégations, pour lire, lancer une commande courte ou faire une petite modification de moins de ${TAILLE_MAX_DIRECTE} caractères quand la déléguer coûterait plus cher ; tes notes dans ~/.claude et les fichiers temporaires, sans limite ; les actions sensibles ou irréversibles à garder sous ton contrôle, comme un push. Quand tu pilotes l'écran avec computer-use, Read, Glob, Grep et Bash ne comptent pas dans ce budget pendant 10 minutes après chaque appel ; les modifications restent comptées. Au-delà, le mod refuse l'appel : délègue. L'utilisateur peut lever ces limites avec /delegation off.`

const CONSIGNE_EXECUTANT = `Tu exécutes une seule tâche confiée par un agent principal, qui lira ton compte rendu et décidera de la suite.

- Fais ce que dit la consigne et reste dans son périmètre.
- Si une information manque ou si la tâche paraît risquée, ne devine pas : arrête-toi et dis ce qui bloque.
- Avant de modifier un projet, lis son CLAUDE.md s'il existe et respecte-le.
- Pas de suppression définitive, de push ni d'action externe si la consigne ne le demande pas.
- Termine par un compte rendu court, en français : ce qui est fait, les fichiers touchés, le résultat des commandes, ce qui n'est pas fait. Ne recopie pas le contenu des fichiers.`

const CONSIGNE_LECTURE = `Tu travailles en lecture seule pour un agent principal, qui lira ton compte rendu et décidera de la suite.

- Ne modifie, ne crée et ne supprime aucun fichier. Tes commandes servent uniquement à chercher, lire ou contrôler.
- Reste dans le périmètre de la consigne. Si une information manque, dis-le au lieu de deviner.
- Termine par un compte rendu court, en français : ce que tu as trouvé, avec fichier et ligne, puis ce que tu n'as pas pu vérifier. Ne recopie pas le contenu des fichiers.`

const OUTILS = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebFetch']
const OUTILS_LECTURE = ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch']

const EQUIPE = [
  { name: 'explorateur', description: 'Chercher, lire, inventorier, résumer. Lecture seule, à bas coût.', prompt: CONSIGNE_LECTURE, tools: OUTILS_LECTURE, model: 'haiku', effort: 'low' },
  { name: 'executant-haiku', description: 'Tâches mécaniques avec écriture, à bas coût.', prompt: CONSIGNE_EXECUTANT, tools: OUTILS, model: 'haiku', effort: 'low' },
  { name: 'executant-sonnet', description: 'Écrire ou modifier du code selon une consigne claire.', prompt: CONSIGNE_EXECUTANT, tools: OUTILS, model: 'sonnet', effort: 'medium' },
  { name: 'relecteur', description: 'Relire un changement et chercher les erreurs, sans rien modifier.', prompt: CONSIGNE_LECTURE, tools: OUTILS_LECTURE, model: 'sonnet', effort: 'medium' },
] as const

const BESOIN_COMPLET =
  /mcp__|(?:^|[^\p{L}])(?:mcp|skills?|blender|archicad|tapir|rhino|figma|canva|navigateur|browser|chrome|simulateur|simulator)(?:$|[^\p{L}])/iu
const AGENTS_LEGERS = new Set(['Explore', 'web-fetch', 'claude-code-guide', 'statusline-setup'])
const INTACTS = /security/i

const famille = (model: string): Famille | 'autre' => {
  const m = model.toLowerCase()
  if (m.includes('fable')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  return m.includes('haiku') ? 'haiku' : 'autre'
}

// Le modèle fort du cerveau, qui borne les sous-agents.
const fortDe = (model: string): Fort => (famille(model) === 'fable' ? 'fable' : 'opus')

const estEffort = (v: unknown): v is Effort => NIVEAUX.includes(v as Effort)
const estReglage = (v: unknown): v is EffortCerveau => v === 'session' || estEffort(v)

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

const texteStats = (s: Stats) =>
  `Agents lancés : Haiku ${s.haiku} · Sonnet ${s.sonnet}` +
  (s.opus > 0 ? ` · Opus ${s.opus}` : '') +
  (s.fable > 0 ? ` · Fable ${s.fable}` : '') +
  (s.retrogrades > 0 ? ` · ${s.retrogrades} rétrogradé(s)` : '')

const texteTokens = (s: Stats) =>
  `Tokens hors lectures de cache : ` +
  (s.tokens.fable > 0 ? `Fable ${k(s.tokens.fable)} · ` : '') +
  `Opus ${k(s.tokens.opus)} · Sonnet ${k(s.tokens.sonnet)} · Haiku ${k(s.tokens.haiku)}`

const texteCache = (s: Stats) => {
  const total = s.cache.lus + s.cache.ecrits + s.cache.neufs

  return total > 0 ? `Cache : ${Math.round((100 * s.cache.lus) / total)} % des tokens d'entrée relus depuis le cache.` : undefined
}

const texteEffort = (r: EffortCerveau) =>
  r === 'session' ? `Effort du cerveau : celui de la session` : `Effort du cerveau : ${r}`

const FENETRES: Record<string, string> = { five_hour: '5 heures', seven_day: '7 jours', spend_limit: 'plafond de dépense' }

type Usage = { session: { usage: () => Promise<{ rateLimits: readonly { kind: string; percentUsed: number }[]; cost?: { usd: number } }> } }

// Le coût et les fenêtres du forfait, tels que la session les connaît ; rien si la lecture échoue.
const texteForfait = async ($: Usage) => {
  try {
    const u = await $.session.usage()
    const lignes: string[] = []
    if (u.cost) lignes.push(`Coût de la session, comme /cost : ${u.cost.usd.toFixed(2).replace('.', ',')} $.`)
    if (u.rateLimits.length > 0) {
      lignes.push(`Forfait consommé : ${u.rateLimits.map(f => `${FENETRES[f.kind] ?? f.kind} ${`${f.percentUsed}`.replace('.', ',')} %`).join(' · ')}.`)
    }

    return lignes
  } catch {
    return []
  }
}

let directs = 0
let fenetreJusqua = 0
let interactive = true
let modeleTour: string | undefined
let ecranTour: boolean | undefined
const conseilsDonnes = new Set<number>()
// Le rappel du seuil franchi, remis au cerveau avec son prochain prompt.
let rappelEnAttente: string | undefined
// Ce que le cerveau veut que le résumé garde ; le compactage se fait entre deux tours.
let compactageDemande: string | undefined
let minuterie: Timer | undefined
const equipeIds = new Set<string>()
const nomsEquipe = new Map<string, string>()
const requetes = new Map<string, number>()
// Un agent arrêté, et pourquoi ; un avis à remettre une fois au prochain appel d'outil de l'agent.
const arrets = new Map<string, Arret>()
const avisEnAttente = new Map<string, string>()
const contextePrevenu = new Set<string>()
// L'effort que le cerveau a demandé : relevé sur l'appel Agent (par son tool_use_id), puis tenu pour l'agent lancé.
const effortsDemandes = new Map<string, Effort>()
const effortsAgents = new Map<string, Effort>()

const estMembre = async ($: { agent: { list: () => Promise<{ id: string; type: string }[]> } }, agentId: string) => {
  if (equipeIds.has(agentId)) return true
  try {
    const info = (await $.agent.list()).find(a => a.id === agentId)
    if (info?.type.startsWith(`${PLUGIN}:`) && EQUIPE.some(m => `${PLUGIN}:${m.name}` === info.type)) {
      equipeIds.add(agentId)
      return true
    }
  } catch {}
  return false
}

const modelePrincipal = async ($: { session: { model: () => Promise<string> } }) =>
  (modeleTour ??= await $.session.model())

type Session = { session: { model: () => Promise<string>; surfaces: () => Promise<readonly string[]> } }

// Un écran dessine la session : session.start l'a dit, ou $.session.surfaces() n'est pas vide
// (l'application de bureau attache son écran après le démarrage). Lu une fois par tour ;
// en cas d'erreur de lecture, on suppose un écran.
const ecranPresent = async ($: Session) => {
  if (interactive) return true
  try {
    return (ecranTour ??= (await $.session.surfaces()).length > 0)
  } catch {
    return true
  }
}

// Le modèle fort que le mod garde pour le raisonnement : Opus ou Fable.
const estFort = (model: string) => /opus|fable/i.test(model)

// Le mode manager ne vaut que si un écran dessine la session et si le modèle principal est Opus ou Fable.
const modeManager = async ($: Session) =>
  (await ecranPresent($)) && estFort(await modelePrincipal($))

type Compactage = 'fait' | 'attente' | { refus: string }

// Compacte la conversation si le cerveau l'a demandé, sans agent en route et entre deux tours.
// Une demande qui ne peut pas passer reste en attente, pour un autre essai.
const compacter = async ($: EngineInterface): Promise<Compactage | undefined> => {
  const instructions = compactageDemande
  if (instructions === undefined) return undefined

  try {
    if ((await $.agent.list()).some(a => !TERMINES.has(a.status))) return 'attente'
  } catch {}

  try {
    const r = await $.session.compact({ instructions })
    compactageDemande = undefined
    if (r.skip !== undefined) {
      $.ui.toast(`Compactage non fait : ${r.skip}`)

      return { refus: r.skip }
    }
    conseilsDonnes.clear()
    rappelEnAttente = undefined
    await update($, stats, old => ({ ...old, compactages: old.compactages + 1 }))
    $.ui.toast(
      r.tokensBefore !== undefined && r.tokensAfter !== undefined
        ? `Conversation compactée : ${k(r.tokensBefore)} → ${k(r.tokensAfter)} tokens.`
        : 'Conversation compactée.',
    )

    return 'fait'
  } catch {
    return 'attente'
  }
}

// Pose la minuterie du compactage, s'il n'y en a pas déjà une.
const planifierCompactage = ($: EngineInterface) => {
  if (minuterie !== undefined) return
  minuterie = $.clock.after(DELAI_COMPACTAGE_MS, async () => {
    minuterie = undefined
    await compacter($)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    conseilsDonnes.clear()
    rappelEnAttente = undefined
    compactageDemande = undefined
    minuterie?.cancel()
    minuterie = undefined
    interactive = e.isInteractive || e.surface !== null
    modeleTour = undefined
    ecranTour = undefined
    tete = 'opus'
    try {
      if (famille(await $.session.model()) === 'fable') tete = 'fable'
    } catch {}
    try {
      const garde = await $.store.get('effort')
      if (estReglage(garde)) await update($, cerveau, () => garde)
    } catch {}
    await update($, fils, () => ({}))
    dernierTexte = undefined
    await afficher($)
    await $.command.register({
      name: 'delegation',
      description: 'Mode manager : état, « on » / « off », « effort <niveau> » ou « compacter [texte] »',
    })
    // Un échec ne doit pas empêcher le reste du démarrage.
    try {
      await $.tool.register({
        name: 'compacter',
        isDeferred: false,
        description:
          'Demande le compactage de la conversation à la fin de ce tour. À appeler seulement quand la tâche en cours est terminée et que le contexte est long, jamais au milieu d\'une tâche. Le compactage remplace la conversation par un résumé.',
        inputSchema: {
          type: 'object',
          properties: {
            a_garder: {
              type: 'string',
              description:
                'Ce que le résumé doit conserver : décisions prises, fichiers touchés, état du travail, ce qui reste à faire, consignes de l\'utilisateur encore valables.',
            },
          },
          required: ['a_garder'],
        },
      })
    } catch {}
    for (const agent of EQUIPE) {
      await $.agent.register({ ...agent, tools: [...agent.tools], omitClaudeMd: true })
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await ecranPresent($)) || !estFort(e.model) || !(await read($, actif))) return composed

    return {
      sections: [
        ...composed.sections,
        { id: `${PLUGIN}:regles`, text: regles(fortDe(e.model)), scope: 'session' },
      ],
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const effort = effortsDemandes.get(e.tool_use_id)
    effortsDemandes.delete(e.tool_use_id)

    const intact =
      e.fork ||
      e.resume !== undefined ||
      INTACTS.test(e.subagentType) ||
      !(await read($, actif)) ||
      !(await modeManager($))
    if (intact) return next(e)

    // Le cerveau décide, la qualité avant l'économie : tout modèle jusqu'au sien. Une demande
    // au-dessus du cerveau (Fable sous Opus) est ramenée au modèle du cerveau.
    const max = fortDe(await modelePrincipal($))
    const demande = e.model === undefined ? 'autre' : famille(e.model)
    const retrograde = demande !== 'autre' && RANGS[demande] > RANGS[max]
    const choisi: Modele | undefined = demande === 'autre' ? undefined : retrograde ? max : demande

    // Sans modèle dans l'appel : celui de l'agent de l'équipe, Haiku pour un agent léger, Sonnet pour
    // un lancement qui ne vient pas d'un appel du cerveau (workflow, coéquipier, agent d'un agent).
    const membre = EQUIPE.find(agent => `${PLUGIN}:${agent.name}` === e.subagentType)
    const horsCerveau = e.workflow !== undefined || e.isTeammate === true || e.parentAgentId !== undefined
    const parDefaut: Modele | undefined =
      membre?.model ?? (AGENTS_LEGERS.has(e.subagentType) ? 'haiku' : horsCerveau ? 'sonnet' : undefined)

    const model = choisi ?? parDefaut
    if (model === undefined) {
      await update($, stats, old => ({ ...old, sansModele: old.sansModele + 1 }))

      return { deny: sansModele(max) }
    }

    if (e.parentAgentId === undefined) directs = 0

    const besoinComplet = BESOIN_COMPLET.test(`${e.description}\n${e.prompt}`)
    const allege =
      !membre &&
      !besoinComplet &&
      e.workflow === undefined &&
      (e.subagentType === 'general-purpose' || e.subagentType === 'Explore')
    // L'agent allégé : l'exécutant Haiku pour Haiku ; l'exécutant Sonnet sinon, qu'Opus ou Fable peut faire tourner.
    const cible =
      e.subagentType === 'Explore' ? 'explorateur' : model === 'haiku' ? 'executant-haiku' : 'executant-sonnet'

    await update($, stats, old => ({
      ...old,
      [model]: old[model] + 1,
      retrogrades: old.retrogrades + (retrograde ? 1 : 0),
      alleges: old.alleges + (allege ? 1 : 0),
    }))

    const lance = await next({
      ...e,
      model,
      subagentType: allege ? `${PLUGIN}:${cible}` : e.subagentType,
    })
    if (lance.agentId !== undefined) {
      if (effort !== undefined) effortsAgents.set(lance.agentId, effort)
      if (membre || allege) {
        equipeIds.add(lance.agentId)
        if (e.name !== undefined) nomsEquipe.set(e.name, lance.agentId)
      }
    }

    return lance
  })

  on('prompt.submit', async ($, e, next) => {
    const rappel = rappelEnAttente
    if (rappel === undefined || e.command !== undefined || !(await read($, actif)) || !(await modeManager($))) {
      return next(e)
    }
    rappelEnAttente = undefined

    return next({ ...e, context: [...(e.context ?? []), rappel] })
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === OUTIL_COMPACTER) {
      if (e.agentId !== undefined) return { deny: 'Le compactage se demande depuis le fil principal.' }
      const aGarder = e.a_garder
      if (typeof aGarder !== 'string' || aGarder.trim() === '') {
        return { deny: 'Dis dans a_garder ce que le résumé doit conserver : décisions, fichiers touchés, état du travail, reste à faire.' }
      }
      compactageDemande = aGarder

      return { result: "Compactage noté : il se fera à la fin de ce tour, quand aucun agent ne tournera. Termine ta réponse à l'utilisateur et ne lance plus d'agent." }
    }

    if (!(await read($, actif)) || !(await modeManager($))) return next(e)

    // L'effort que l'appel Agent demande : agent.spawn le retrouve par le tool_use_id.
    if (e.tool === 'Agent' && e.tool_use_id !== undefined && estEffort(e.effort)) {
      effortsDemandes.set(e.tool_use_id, e.effort)
    }

    if (e.agentId !== undefined) {
      if ((e.tool as string) !== 'SubagentHandback') {
        const arret = arrets.get(e.agentId)
        if (arret) return { deny: ARRETS[arret].agent }

        const avis = avisEnAttente.get(e.agentId)
        if (avis !== undefined) {
          avisEnAttente.delete(e.agentId)
          return { deny: avis }
        }
      }
      return next(e)
    }

    if (e.tool === 'SendMessage' && typeof e.to === 'string') {
      const arret = arrets.get(nomsEquipe.get(e.to) ?? e.to)
      if (arret) return { deny: ARRETS[arret].principal }
    }

    if (e.tool.startsWith('mcp__computer-use__')) {
      fenetreJusqua = (await $.clock.now()) + FENETRE_CONTROLE_MS
      return next(e)
    }

    const refus = async (raison: string) => {
      await update($, stats, old => ({ ...old, blocages: old.blocages + 1 }))
      return { deny: `Mode manager : ${raison} Si l'utilisateur veut que tu le fasses toi-même, il tape /delegation off.` }
    }

    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const chemin = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
      if (ECRITURE_LIBRE.test(chemin)) return next(e)

      const taille =
        e.tool === 'Edit'
          ? Math.max(e.old_string.length, e.new_string.length)
          : e.tool === 'Write'
            ? e.content.length
            : e.new_source.length
      if (taille > TAILLE_MAX_DIRECTE) {
        return refus(`cette modification dépasse ${TAILLE_MAX_DIRECTE} caractères. Confie-la à executant-haiku ou executant-sonnet.`)
      }
    }

    if (OUTILS_LECTURE_LIBRES.has(e.tool) && fenetreJusqua > 0 && (await $.clock.now()) < fenetreJusqua) {
      return next(e)
    }

    if (OUTILS_DIRECTS.has(e.tool) || e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      if (directs >= BUDGET_DIRECT) {
        return refus(`tu as utilisé tes ${BUDGET_DIRECT} appels directs, modifications comprises. Confie la suite à explorateur ou à un exécutant ; lancer un agent rouvre ce budget.`)
      }
      directs += 1
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? PRINCIPAL
    const fam = famille(e.model)
    if (fam !== 'autre') {
      if (e.agentId === undefined && (fam === 'opus' || fam === 'fable')) tete = fam
      // Un fil reste allumé de sa première requête à son turn.complete ; on retire en passant
      // les agents que $.agent.list() ne connaît plus ou dont la boucle est terminée.
      let vivants: Set<string> | undefined
      try {
        const liste = await $.agent.list()
        vivants = new Set(liste.filter(a => !TERMINES.has(a.status)).map(a => a.id))
        if (e.agentId !== undefined) vivants.add(e.agentId)
      } catch {}
      await update($, fils, old => {
        const garde = Object.entries(old).filter(([cle]) => cle === PRINCIPAL || !vivants || vivants.has(cle))
        const pareil = garde.length === Object.keys(old).length && old[id] === fam
        return pareil ? old : { ...Object.fromEntries(garde), [id]: fam }
      })
      await afficher($)
    }

    // L'effort : celui du cerveau sur le fil principal, celui que le cerveau a demandé pour un agent.
    // Un effort absent (modèle sans effort) ou donné en nombre par la session est laissé tel quel.
    let envoi = e
    const demande = e.effort
    if (typeof demande === 'string' && (await read($, actif)) && (await modeManager($))) {
      if (e.agentId === undefined) {
        const reglage = await read($, cerveau)
        if (reglage !== 'session' && reglage !== demande) envoi = { ...e, effort: reglage }
      } else {
        const voulu = effortsAgents.get(e.agentId)
        if (voulu !== undefined && voulu !== demande) envoi = { ...e, effort: voulu }
      }
    }

    const reponse = yield* next(envoi)
    const u = reponse.usage
    const contexte = u ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : 0

    if (e.agentId === undefined && u && (await read($, actif)) && (await modeManager($))) {
      // Le conseil du seuil le plus haut franchi, une fois ; les seuils plus bas sont tenus pour dits.
      const franchi = CONSEILS.findIndex(([seuil]) => contexte > seuil)
      if (franchi !== -1) {
        const [seuilFranchi, toast, rappel] = CONSEILS[franchi]!
        const dejaDit = conseilsDonnes.has(seuilFranchi)
        for (const [seuil] of CONSEILS.slice(franchi)) conseilsDonnes.add(seuil)
        if (!dejaDit) {
          $.ui.toast(toast)
          rappelEnAttente = rappel
        }
      }
    }

    if (e.agentId !== undefined && equipeIds.has(e.agentId)) {
      const agentId = e.agentId
      const avertir = async (avis: string) => {
        const attente = avisEnAttente.get(agentId)
        avisEnAttente.set(agentId, attente === undefined ? avis : `${attente}\n\n${avis}`)
        await update($, stats, old => ({ ...old, avertis: old.avertis + 1 }))
      }
      const arreter = async (raison: Arret) => {
        if (arrets.has(agentId)) return
        arrets.set(agentId, raison)
        await update($, stats, old => ({ ...old, arretes: old.arretes + 1 }))
      }

      const n = (requetes.get(agentId) ?? 0) + 1
      requetes.set(agentId, n)
      if (n === REQUETES_AVERTISSEMENT_AGENT) await avertir(AVIS_REQUETES)
      if (n === REQUETES_MAX_AGENT) await arreter('requetes')

      if (fam === 'haiku') {
        if (contexte > CONTEXTE_MAX_HAIKU) {
          await arreter('contexte')
        } else if (contexte > CONTEXTE_AVERTISSEMENT_HAIKU && !contextePrevenu.has(agentId)) {
          contextePrevenu.add(agentId)
          await avertir(AVIS_CONTEXTE)
        }
      }
    }

    if (u) {
      const total = u.input_tokens + u.cache_creation_input_tokens + u.output_tokens
      await update($, stats, old => ({
        ...old,
        tokens: { ...old.tokens, [fam]: old.tokens[fam] + total },
        cache: {
          lus: old.cache.lus + u.cache_read_input_tokens,
          ecrits: old.cache.ecrits + u.cache_creation_input_tokens,
          neufs: old.cache.neufs + u.input_tokens,
        },
      }))
    }

    return reponse
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? PRINCIPAL
    await update($, fils, old => {
      if (!(id in old)) return old
      const { [id]: _, ...reste } = old
      return reste
    })
    await afficher($)

    const fini = await next(e)
    // Le tour du cerveau est fini : le compactage peut passer, un peu plus tard. Une demande
    // restée en attente est retentée à la fin du tour suivant.
    if (e.agentId === undefined && compactageDemande !== undefined && e.reason === 'answer') {
      planifierCompactage($)
    }

    return fini
  })

  on('prompt.attachment', async ($, e, next) => {
    if (e.agentId === undefined || !ATTACHEMENTS_MCP.has(e.type)) return next(e)
    if (!(await read($, actif)) || !(await modeManager($)) || !(await estMembre($, e.agentId))) return next(e)

    return { text: null }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      directs = 0
      modeleTour = undefined
      ecranTour = undefined
    }

    return next(e)
  })

  on('command.run', { command: 'delegation' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    const demande = /^compacter(?:\s+([\s\S]*))?$/i.exec(e.args.trim())
    if (demande) {
      compactageDemande = demande[1]?.trim() || CONSIGNE_COMPACTAGE
      // Le moteur refuse $.session.compact depuis un hook de commande : la minuterie le lance après.
      planifierCompactage($)

      return { text: 'Compactage noté : il se fera dès que le tour en cours et les agents auront fini.' }
    }

    if (arg === 'on' || arg === 'off') {
      await update($, actif, () => arg === 'on')

      return { text: arg === 'on' ? 'Mode manager activé.' : 'Mode manager désactivé : aucun routage de modèle, aucune limite, aucun réglage d\'effort.' }
    }

    const effort = /^effort(?:\s+(\S+))?$/.exec(arg)
    if (effort) {
      const niveau = effort[1]
      if (!estReglage(niveau)) {
        return { text: `${texteEffort(await read($, cerveau))}. Pour le changer : /delegation effort low, medium, high, xhigh ou max ; « session » laisse le réglage de la session.` }
      }
      await update($, cerveau, () => niveau)
      // Le choix vaut pour les sessions suivantes ; si l'écriture échoue, il vaut pour celle-ci.
      try {
        await $.store.set('effort', niveau)
      } catch {}

      return { text: `${texteEffort(niveau)}, pour cette session et les suivantes.` }
    }

    const s = await read($, stats)
    const etat = (await read($, actif)) ? 'active' : 'désactivée'
    const principal = await $.session.model()

    return {
      text: [
        `Délégation ${etat}. Session principale : ${principal}. ${texteEffort(await read($, cerveau))}.`,
        `${texteStats(s)} (${s.alleges} allégé(s), ${s.sansModele} appel(s) refusé(s) faute de modèle, ${s.blocages} appel(s) direct(s) refusé(s)).`,
        `Agents de l'équipe : ${s.avertis} avertissement(s), ${s.arretes} arrêt(s). Seuils : ${REQUETES_AVERTISSEMENT_AGENT} puis ${REQUETES_MAX_AGENT} requêtes ; pour Haiku, ${milliers(CONTEXTE_AVERTISSEMENT_HAIKU)} puis ${milliers(CONTEXTE_MAX_HAIKU)} tokens de contexte.`,
        `${texteTokens(s)}.`,
        `Contexte : ${s.compactages} compactage(s) ; rappel au cerveau à ${milliers(SEUIL_BAS)} puis ${milliers(SEUIL_HAUT)} tokens.`,
        texteCache(s),
        ...(await texteForfait($)),
      ]
        .filter(ligne => ligne !== undefined)
        .join('\n'),
    }
  })
}
