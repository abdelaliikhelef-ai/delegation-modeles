export type Famille = 'fable' | 'opus' | 'sonnet' | 'haiku'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// L'effort que le mod donne au fil principal ; « session » laisse le réglage de la session.
export type EffortCerveau = Effort | 'session'

export type Stats = {
  haiku: number
  sonnet: number
  opus: number
  fable: number
  retrogrades: number
  alleges: number
  sansModele: number
  blocages: number
  arretes: number
  avertis: number
  tokens: { fable: number; opus: number; sonnet: number; haiku: number; autre: number }
  cache: { lus: number; ecrits: number; neufs: number }
}

export type Fils = Record<string, Famille>

declare module 'claude-code' {
  interface PluginState {
    'modeles': {
      stats: Shaped<Stats>
      actif: Shaped<boolean>
      fils: Shaped<Fils>
      cerveau: Shaped<EffortCerveau>
    }
  }
}
