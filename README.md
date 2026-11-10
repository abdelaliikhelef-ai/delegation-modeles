# modeles

Mode manager pour Claude Code : le modèle principal (Opus ou Fable), le cerveau, réfléchit, décide et contrôle, et une équipe d'agents exécute, sur le modèle que la tâche demande, de Haiku jusqu'au modèle du cerveau. La qualité passe avant l'économie : le cerveau prend le modèle le moins cher qui fait la tâche solidement et complètement. Le cerveau choisit le modèle et l'effort de chaque agent ; le mod fait respecter ce choix, fournit quatre agents (explorateur, executant-haiku, executant-sonnet, relecteur) et ajoute une section de règles au prompt.

## Installation

Dans une session Claude Code en terminal :

```
/plugin install modeles --marketplace abdelaliikhelef-ai/delegation-modeles
```

Répondre `y` pour ajouter le marketplace, puis choisir la portée. Depuis un shell :

```
claude plugin install modeles --marketplace abdelaliikhelef-ai/delegation-modeles
```

Le dépôt est privé : il faut y être invité sur GitHub et avoir GitHub configuré sur son ordinateur. Redémarrer Claude Code après l'installation.

## Effort du cerveau

Le fil principal tourne en effort `high` par défaut, quel que soit le réglage de la session. `/delegation effort xhigh` (ou `low`, `medium`, `high`, `max`) change ce niveau, `/delegation effort session` rend la main au réglage de la session. Le choix est retenu d'une session à l'autre.

## Modèle et effort des agents

C'est le cerveau qui décide, avec les paramètres `model` et `effort` de l'outil Agent. Les règles ajoutées au prompt le lui demandent et lui donnent des repères.

Un sous-agent tourne sur n'importe quel modèle jusqu'à celui du cerveau, jamais au-dessus. Un modèle plus haut sert à ce que le modèle du dessous ne fait pas bien et qui doit rester solide et complet.

| Cerveau | Modèles permis en sous-agent | Demande plus haute |
| - | - | - |
| Fable | Haiku, Sonnet, Opus, Fable | aucune |
| Opus | Haiku, Sonnet, Opus | Fable est ramené à Opus |

| Cas | Modèle | Effort |
| - | - | - |
| L'appel donne `model` | celui demandé, dans la limite ci-dessus | celui de l'appel, sinon celui de l'agent |
| Agent de l'équipe, sans `model` | celui de l'agent | celui de l'appel, sinon celui de l'agent (`low` sur Haiku, `medium` sur Sonnet) |
| Agent léger (`Explore`, `web-fetch`, `claude-code-guide`, `statusline-setup`), sans `model` | Haiku | celui de l'appel, sinon celui du modèle |
| Tout autre appel du cerveau, sans `model` | appel refusé : le cerveau doit choisir | |
| Lancement qui ne vient pas d'un appel du cerveau (workflow, coéquipier, agent d'un agent), sans `model` | Sonnet | celui du modèle |

Un `general-purpose` ou un `Explore` dont la consigne ne nomme ni MCP ni skill est remplacé par l'agent allégé de l'équipe (sans `CLAUDE.md`, MCP ni skills). Les agents `fork`, les agents repris et les agents de sécurité ne sont pas touchés.

## Limites

- 5 appels directs entre deux délégations pour le fil principal (lecture, commande, petite modification) ; au-delà l'appel est refusé.
- 600 caractères au maximum pour une modification faite directement ; au-delà, déléguer.
- Agents de l'équipe : avertissement à 40 requêtes, arrêt à 80 requêtes.
- Agents Haiku de l'équipe : avertissement à 70 000 tokens de contexte, arrêt à 95 000. Au-delà de 100 000 tokens de prompt, une requête Haiku 5.5 coûte cinq fois plus cher.

## Conseil de nouvelle session

Quand le contexte du fil principal dépasse 120 000 tokens, puis 200 000, le mod affiche une fois un message qui conseille d'ouvrir une nouvelle session pour le chantier suivant.

## Commande

- `/delegation` affiche l'état, les agents lancés, les avertissements et arrêts, les tokens par modèle, la part des tokens d'entrée relus depuis le cache, le coût de la session et la part consommée du forfait (fenêtres de 5 heures et de 7 jours).
- `/delegation on` active le mode, `/delegation off` lève les limites, le routage et le réglage d'effort.
- `/delegation effort <niveau>` règle l'effort du cerveau.

## Quand il ne s'applique pas

Le mod ne fait rien si aucun écran ne dessine la session (`claude -p`, SDK sans écran) ou si le modèle principal n'est ni Opus ni Fable. Un écran est présent sous le terminal comme dans l'application de bureau, et le mod le relit à chaque tour : ni limites, ni redirection de modèle, ni règles ajoutées. Le modèle est relu à chaque tour, donc un changement de modèle en cours de session est pris en compte.

## Texte sous la saisie

Le mod affiche en permanence, par `$.ui.status`, une ligne de texte simple sous la zone de saisie : `Opus · Sonnet · Haiku`, ou `Fable · Opus · Sonnet · Haiku` quand le fil principal tourne sur Fable. Un modèle en train de travailler (fil principal ou agent, de sa première requête à son `turn.complete`) est précédé de « 🟢 » : `🟢 Opus · Sonnet · 🟢 Haiku`. Le texte est mis à jour à chaque changement et au démarrage de la session, que le mode manager soit actif ou non, et n'est envoyé que s'il a changé. Un agent absent de `$.agent.list()` ou terminé est retiré.
