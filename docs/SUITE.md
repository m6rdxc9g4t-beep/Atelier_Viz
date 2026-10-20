# Suite Atelier — contrat commun

Ce document est **identique** dans les trois dépôts (`Atelier_Viz`, `atelier-tab`, `Atelier_Projets`), sous `docs/SUITE.md`.
Il fixe ce que les trois applications partagent : identité visuelle, ports, navigation, échanges de données.
Toute modification se fait dans les trois dépôts à la fois.

| Application | Rôle | Stack |
|---|---|---|
| **Atelier Viz** | BI locale (rapports, visuels, IA) | FastAPI + DuckDB · React |
| **Atelier Tab** | Tableur + base typée | React · Electron (bureau) |
| **Atelier Projets** | Projets agiles, Git, temps passé | Fastify + Prisma/SQLite · React |

Principes partagés : **local d'abord** (rien ne quitte la machine hors ligne), interface **en français**, IA locale par Ollama (`http://localhost:11434`), clair + sombre (« néon monochrome » dans la couleur de chaque app, §1.7).

---

## 1. Identité visuelle

### 1.1 Source de vérité
Le design system d'Atelier Projets (`Atelier_Projets/design-system/`) est la référence.
Viz et Tab en embarquent une **copie verbatim** de trois fichiers, sans modification :

| Fichier de référence | Copie dans Viz | Copie dans Tab |
|---|---|---|
| `design-system/themes/light.css` | `frontend/src/styles/atelier-ds/light.css` | `src/styles/atelier-ds/light.css` |
| `design-system/themes/dark.css` | `frontend/src/styles/atelier-ds/dark.css` | `src/styles/atelier-ds/dark.css` |
| `design-system/tokens/colors.css` | `frontend/src/styles/atelier-ds/colors.css` | `src/styles/atelier-ds/colors.css` |

Chaque copie commence par le commentaire d'origine ; un test (Vitest) vérifie la présence des variables de fondation
(`--bg-main`, `--bg-surface`, `--bg-elevated`, `--text-primary`, `--text-muted`, `--border-color`) et des 15 couleurs officielles (`--type-*`, `--status-*`).

### 1.2 Correspondance des jetons
Chaque application garde ses propres noms de jetons (les composants ne changent pas), mais **leurs valeurs dérivent des variables de fondation** :

| Rôle | Projets (référence) | Viz | Tab |
|---|---|---|---|
| Fond de l'application | `--bg-main` | `--bg`, `--canvas` | `--surface-sunken` |
| Surface (cartes, panneaux) | `--bg-surface` | `--surface` | `--surface`, `--surface-raised` |
| Surface élevée / survol | `--bg-elevated` | `--surface-2` | `--surface-hover` |
| Texte | `--text-primary` | `--fg` | `--ink` |
| Texte secondaire | `--text-muted` | `--muted` | `--muted`, `--faint` (mélange) |
| Bordures | `--border-color` | `--border`, `--grid` | `--line`, `--line-strong` (mélange) |
| Accent (onglet actif, bouton principal) | `--accent` = `--atelier-signature` (§1.7) | `--accent` | `--accent` |
| Succès / danger / attention | `--status-closed` / `--status-rejected` / `--status-hold` | `--positive` / `--negative` | `--success` / `--danger` / `--warning` |

Les dérivés (`--accent-soft`, mélanges) utilisent `color-mix(in oklab, …)` comme `design-system/tokens/ui.css`.

**Exception dataviz** : la palette de données de Viz (`--series-1..8`, `--seq-*`, `--div-*`) et les thèmes de rapport restent inchangés
(palette validée daltonisme/contraste). Seul l'habillage de l'application suit le design system.

### 1.3 Forme et typographie
- Rayons : 6 / 10 / 16 px (`--ds-radius-sm|md|lg`).
- Police : pile système (`ui-sans-serif, system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, …`), mono `ui-monospace, "SF Mono", …`.
  Aucune police téléchargée (pas de CDN, pas de Google Fonts). Exception : la police de marque embarquée (§1.6).

### 1.4 Statuts et types
Les 8 statuts et leurs libellés français sont communs. Toute interface qui affiche un statut de workflow utilise ces couleurs.

| Code | Libellé | Variable |
|---|---|---|
| `OPEN` | À faire | `--status-open` |
| `IN_PROGRESS` | En cours | `--status-progress` |
| `IN_REVIEW` | En revue | `--status-review` |
| `ON_HOLD` | En attente | `--status-hold` |
| `BLOCKED` | Bloquée | `--status-blocked` |
| `RESOLVED` | Résolue | `--status-resolved` |
| `CLOSED` | Terminée | `--status-closed` |
| `REJECTED` | Rejetée | `--status-rejected` |

Correspondance libellé → code (import) : comparaison insensible à la casse et aux accents, sur le libellé **ou** le code ;
synonymes acceptés : « Ouvert », « Nouveau » → `OPEN` ; « Fait », « Terminé », « Clos » → `CLOSED` ; « Bloqué » → `BLOCKED` ; « Résolu » → `RESOLVED` ; « Rejeté », « Annulé » → `REJECTED`.

### 1.5 Thème clair / sombre
Sur `<html>`, chaque application pose **les deux marqueurs** :
- sombre : `class="dark"` **et** `data-theme="dark"` ;
- clair : pas de classe `dark` et `data-theme="light"`.
Choix proposés : Clair, Sombre, Système. Chaque application garde sa propre clé de préférence.

### 1.6 Marque (logo + nom)
Les huit applications Atelier (Projets, Viz, Tab, Ciné, Savoir, Trésorerie, Nexus, Dates) affichent leur marque de la même façon,
comme sur leurs logos : tuile en verre cerclée de la **couleur signature** de l'app (§1.7), icône Lucide dans cette couleur,
puis `atelier_` atténué et le nom en gras.

- Source : `Atelier_Projets/design-system/brand/` (`atelier-brand.css`, police Nunito variable embarquée, licence OFL).
  Copies verbatim : `frontend/src/styles/atelier-brand/` (Viz), `src/styles/atelier-brand/` (Tab),
  `frontend/src/brand/` (Ciné), `static/brand/` (Savoir, Trésorerie), et dans Nexus et Dates.
- Balisage : `button.atelier-brand` > `.atelier-brand__tile` (icône) + `.atelier-brand__name` > `.atelier-brand__prefix` (« atelier_ ») + nom.
- Icônes : Projets `calendar-check`, Viz `chart-column`, Tab `table-2`, Ciné `play`, Savoir `graduation-cap`, Trésorerie `landmark`.
- La police de marque ne sert qu'à la marque ; le reste de l'interface garde la pile système.
- Clic sur la marque : fenêtre « À propos » (`<dialog class="atelier-about">`) avec le logo complet de l'application en grand, son nom et une phrase de présentation. Identique partout, toujours sombre.
- Icônes : l'icône d'application (Dock, `.app`, Electron) est le logo complet ; le favicon (`favicon-64.png`, `apple-touch-icon.png`) est la tuile de l'étiquette du logo.

### 1.7 Charte « néon monochrome » et couleurs signature
Charte complète : document « Charte graphique : style néon holographique 3D » (piste C validée). Résumé pour le code :

- **Chaque application est entièrement dans sa couleur signature** : fond, barre latérale, surfaces, bordures, textes,
  halos et grille dérivent de `--atelier-signature` par mélange (`color-mix`) et transparence. Pas de couleur de structure commune.
- Activation : `data-atelier-app="<app>"` sur `<html>` (ou sur un élément, ex. chaque entrée du sélecteur de la suite, qui prend SA couleur).

| App | `data-atelier-app` | Signature |
|---|---|---|
| Dates | `dates` | `#E03131` rouge |
| Nexus | `nexus` | `#E8590C` orange foncé |
| Viz | `viz` | `#F2C811` jaune |
| Projets | `projets` | `#94D82D` vert citron |
| Tab | `tab` | `#21A366` vert |
| Trésorerie | `tresorerie` | `#3B5BDB` bleu roi |
| Savoir | `savoir` | `#9B5DE5` violet |
| Ciné | `cine` | `#E64980` magenta |

- `brand/atelier-brand.css` fournit, pour le thème clair et le thème sombre, les jetons que chaque application branche sur ses
  propres variables (§1.2) : `--atelier-bg`, `--atelier-sidebar`, `--atelier-surface`, `--atelier-surface-2|3`, `--atelier-field`,
  `--atelier-text`, `--atelier-muted`, `--atelier-ink` (signature lisible en texte), `--atelier-border`, `--atelier-border-soft`,
  `--atelier-line`, `--atelier-signature-soft|faint`, `--atelier-glow`, `--atelier-glow-strong`, `--atelier-signature-glow`,
  `--atelier-text-glow`, `--atelier-focus`, `--atelier-backdrop` (grille + lueur), `--atelier-chart-1..3`, `--atelier-chart-fill`.
- **Sombre** : fond quasi noir teinté, fine grille, cartes cerclées d'un trait néon de la couleur avec halo, bouton principal en contour néon.
- **Clair** : fond très clair teinté, même grille, cartes blanches cerclées de la couleur avec léger halo, bouton principal plein.
- `themes/dark.css` reste une base neutre quasi noire (CSS pur, copiable) : la teinte vient des jetons `--atelier-*`.
- Les couleurs de **données** (types, statuts, séries Viz, positif / négatif) ne changent pas.

---

## 2. Ports et adresses

| Application | Interface (dev) | Interface (aperçu / app) | API |
|---|---|---|---|
| Atelier Viz | `http://127.0.0.1:5173` | `http://127.0.0.1:8000` (servie par FastAPI) | `http://127.0.0.1:8000/api` |
| Atelier Projets | `http://127.0.0.1:5174` | `http://127.0.0.1:4174` | `http://127.0.0.1:3000/api` |
| Atelier Tab | `http://127.0.0.1:5175` | `http://127.0.0.1:4175` · app Electron | santé seulement : `http://127.0.0.1:4175/api/health` (app de bureau ou aperçu), `http://127.0.0.1:5175/api/health` (dev) |

`strictPort: true` sur chaque serveur Vite : en cas de conflit, échec explicite plutôt qu'un port au hasard.

---

## 3. Navigation dans la suite

Chaque en-tête d'application porte un **sélecteur « Suite Atelier »** (icône grille, à gauche du nom de l'app) :
- trois entrées, dans la marque commune (§1.6, variante compacte `atelier-brand__tile--sm` / `atelier-brand__name--sm`) :
  tuile néon (chaque entrée porte son `data-atelier-app`, donc sa couleur signature) + icône, puis « atelier_Viz » (`BarChart3`), « atelier_Tab » (`Table2`), « atelier_Projets » (`CalendarCheck`),
  avec une ligne de description ; le nom accessible reste « Atelier Viz », « Atelier Tab », « Atelier Projets » ;
- l'application courante est cochée ;
- un clic ouvre l'adresse de l'application (colonne « Interface (aperçu / app) » ci-dessus) :
  - dans un navigateur : nouvel onglet ;
  - dans une app de bureau (macOS) : l'enveloppe de bureau reconnaît l'adresse d'une app de la suite et **ouvre l'application installée**
    (`/usr/bin/open -b <identifiant>`), sinon l'adresse part dans le navigateur par défaut.
    Identifiants : Viz `fr.atelier-viz.app`, Tab `fr.atelier.tab`, Projets `local.atelier-projets.desktop`.
    Reconnaissance par hôte (`127.0.0.1` ou `localhost`) et port : 8000 → Viz, 4175 → Tab, 4174 → Projets.
    Mécanisme : `DesktopApi.open_external` (Viz), `shell.openExternal` relayé par le processus principal (Tab), `setWindowOpenHandler` (Projets) ;
- un indicateur « en marche / arrêtée » est affiché pour **les trois** applications (`GET …/api/health`, délai 1,5 s, `mode: 'no-cors'`, sans bloquer le menu) ;
  l'application courante est toujours « en marche ».
  Atelier Tab n'a pas d'API de données : il expose seulement une route de santé.
  - App de bureau : le processus principal écoute sur `127.0.0.1:4175` (jamais une autre interface réseau) et ne sert que
    `GET /api/health` → `{"status":"ok","app":"atelier-tab"}` et `GET /` → page minimale « Atelier Tab est ouvert » qui ramène la fenêtre au premier plan.
    Aucune donnée, aucune autre route (404). Si le port est pris, l'app fonctionne normalement sans indicateur (journalisé).
  - `npm run dev` / `npm run preview` : même réponse sur `/api/health` (petit greffon Vite).
  - Les autres apps sondent `http://127.0.0.1:4175/api/health` puis `http://127.0.0.1:5175/api/health` : l'un des deux répond → « en marche ».

Les adresses sont des constantes dans un module dédié (`suite.ts`), surchargeables par variables d'environnement Vite
(`VITE_ATELIER_VIZ_URL`, `VITE_ATELIER_TAB_URL`, `VITE_ATELIER_PROJETS_URL`, et, dans Tab, `VITE_ATELIER_PROJETS_API_URL` pour l'adresse de santé de Projets).
Dans une app, l'état de l'app courante se vérifie sur sa propre origine (`/api/health`), pas à l'adresse fixe.

Nom affiché : **Atelier Viz**, **Atelier Tab**, **Atelier Projets** (avec une espace) dans les titres de fenêtre et noms accessibles ; « atelier_Nom » dans la marque (§1.6).
Les noms techniques (dépôts, dossier `~/Atelier_Tab`, paquets) ne changent pas.

---

## 4. Échanges de données

```
 Atelier Tab ──(DataFlow v2.1.0, webhook ou fichier)──▶ Atelier Projets
      │                                                     │
      └──(instantanés DataFlow ~/Atelier_Tab/exports)──▶ Atelier Viz ◀──(GET /api/exports/datasets)──┘
```

### 4.1 Tab → Projets : import DataFlow
**Projets** expose :

- `POST /api/imports/atelier-tab/preview` — corps : enveloppe DataFlow v2.1.0 (`docs/DATAFLOW_SPEC.md` d'Atelier Tab). Ne modifie rien.
- `POST /api/imports/atelier-tab` — même corps ; crée ou met à jour.

Paramètres de requête facultatifs : `projectId` (projet cible ; sinon projet dont le nom = `project.name`, créé s'il n'existe pas), `type` (`TASK` par défaut, ou `FEATURE` / `BUG`).
En-têtes : `Idempotency-Key` (une même clé rejouée renvoie la même réponse sans réimporter), `X-Atelier-Schema-Version: 2.1.0` (si présent et différent → 422), `Authorization: Bearer <jeton>` ignoré s'il n'y a pas de jeton configuré (`ATELIER_IMPORT_TOKEN`), exigé sinon.

Rangement : Phase « Imports Atelier Tab » › Epic `<workspace.name>` › Story `<source_table.name ?? project.name>` (créés au besoin, retrouvés par nom).

Correspondance des colonnes (`atelier_mapping`) :

| Rôle | WorkItem |
|---|---|
| `entity_title` | `title` (obligatoire ; ligne ignorée avec avertissement si vide) |
| `workflow_state` | `status` (règles §1.4 ; inconnu → `OPEN` + avertissement) |
| `start_date` / `due_date` | `startDate` / `dueDate` (ISO `AAAA-MM-JJ`) |
| `description` | début de `description` |
| autres (`assignee`, `financial_ht`, `financial_ttc`, `quantity`, `flag`, `custom`) | tableau Markdown « Données Atelier Tab » ajouté à `description` |

Identité : chaque élément importé garde `externalRef = "atelier-tab:<source_table.id ?? project.id>:<record_id>"` ; un réimport **met à jour** l'élément au lieu d'en créer un autre.
Réponse (`200`) : `{ projectId, storyId, created, updated, skipped, warnings: string[], items: [{ recordId, workItemId, action }] }`.

CORS : ces deux routes acceptent les seules origines `http://127.0.0.1:*` et `http://localhost:*`, méthodes `POST, OPTIONS`,
en-têtes `Content-Type, Authorization, Idempotency-Key, X-Atelier-Schema-Version`.
L'app de bureau Tab (origine `app://atelier`) n'envoie pas depuis la page : le processus principal relaie la requête **sans en-tête `Origin`**,
uniquement vers `http(s)://127.0.0.1|localhost/api/imports/atelier-tab[/preview]` et avec les seuls en-têtes ci-dessus.
Projets traite une requête sans `Origin` comme un appel local ordinaire (garde `local-only`). L'origine `null` est **refusée** :
n'importe quelle page web peut l'envoyer (iframe sandbox, URL `data:`, fichier local).
Jeton `ATELIER_IMPORT_TOKEN` (facultatif) : exigé des appels externes (sans `Origin` ou d'une autre origine), pas de l'interface de Projets elle-même ;
vérifié avant la lecture du corps.
La réponse peut contenir davantage que le minimum ci-dessus (compteur `unchanged`, détail par ligne, en-tête `Idempotency-Replayed`) ;
`schema_version` du corps est contrôlé comme l'en-tête (≠ 2.1.0 → 422).

**Tab** propose par défaut l'adresse `http://127.0.0.1:3000/api/imports/atelier-tab` dans le transport webhook (préréglage « Atelier Projets (local) »).
**Projets** propose aussi l'import d'un fichier JSON DataFlow depuis son interface (aperçu, puis import).

### 4.2 Tab → Viz : instantanés
L'app de bureau Tab écrit, à chaque enregistrement d'une table, un instantané `~/Atelier_Tab/exports/<tableId>.json` :
l'enveloppe DataFlow v2.1.0 produite par `toAtelierPayload` (valeurs `computed` évaluées par le moteur), **sans** les contrôles bloquants
de `validate.ts` (une table sans colonne `entity_title` est publiée quand même). Écriture atomique ; suppression quand la table est supprimée.
Les colonnes sans rôle reçoivent `custom`.

**Viz** :
- reconnaît une enveloppe DataFlow (`target_system` + `schema_version` + `project.columns_schema`) à l'import d'un fichier JSON et l'aplatit : une colonne par entrée de `columns_schema` (nom = `label`), valeur = `computed` (les codes d'erreur `#…!` deviennent vides), types déduits de `type` (`currency|number|percent|formula numérique` → nombre, `date` → date, `checkbox` → booléen, sinon texte) ; colonnes `_ligne` (`row_index`) et `_id` (`record_id`) en tête ;
- ajoute un connecteur **« Atelier Tab »** : dossier (défaut `~/Atelier_Tab/exports`), liste des tables publiées (nom, projet, date), import et actualisation (`origin` mémorisée). Aucun réseau.

### 4.3 Projets → Viz : jeux de données
**Projets** expose (lecture seule, local uniquement) :

- `GET /api/exports/datasets` → `[{ name, label, description, rowCount }]`
- `GET /api/exports/datasets/:name?projectId=<id>` → `{ name, label, generatedAt, columns: [{ key, label, type }], rows: object[] }`
  avec `type ∈ "string" | "number" | "date" | "datetime" | "boolean"` ; `rows` utilise les `key` des colonnes.

Jeux : `work-items` (id, projet, phase, epic, story, type, statut (libellé), statut_code, priorité, titre, heures_estimées, heures_passées, écart_heures, avancement, début, échéance, créé_le, maj_le),
`time-entries` (id, élément_id, élément, type, projet, date, heures, commentaire), `milestones` (id, projet, phase, nom, date, atteint).
Les clés sont en `snake_case` sans accent (`heures_estimees`), les libellés en français avec accents.

**Viz** ajoute un connecteur **« Atelier Projets »** : adresse (défaut `http://127.0.0.1:3000`), choix du jeu et du projet (facultatif), import et actualisation.
Adresse **locale uniquement**, quel que soit le mode : `127.0.0.1`, `localhost` ou `::1` (après résolution).

---

## 5. Intelligence artificielle

Les trois applications proposent le **même choix de moteur**, avec la même interface et les mêmes règles.

### 5.1 Mode hors ligne / en ligne
- Chaque application a un interrupteur **« Hors ligne / En ligne »** dans son en-tête (comme Atelier Viz), **hors ligne par défaut**,
  mémorisé par application (Viz : `PreferencesStore` ; Projets : réglage du backend ; Tab : fichier de préférences **hors du dossier de données**,
  à côté du fichier de secrets — le dossier `~/Atelier_Tab` est modifiable par les IA, le mode en ligne ne doit pas l'être).
- Aucune IA (outil de l'assistant, serveur MCP) ne peut passer une application en ligne ; seul l'utilisateur le fait.
- Les routes qui changent le mode (Viz, Projets) n'acceptent que des requêtes locales : `Host` de bouclage et, pour toute écriture, `Origin` absente ou de bouclage (protection contre le DNS rebinding et les requêtes d'un autre site).
- Hors ligne, **rien ne part vers Claude** : le choix « Claude » est grisé avec l'explication, et une requête explicite est refusée
  (HTTP 403 ou erreur, message en français).

### 5.2 Choix du moteur
Commande segmentée **« Moteur : Auto · Ollama · Claude »** à l'endroit où l'on utilise l'IA, plus :
- **Ollama** : liste des modèles locaux (`http://localhost:11434`), modèle choisi mémorisé ;
- **Claude** : modèle `Sonnet` (défaut), `Opus` ou `Haiku` (alias `sonnet` / `opus` / `haiku`), mémorisé ;
- **Auto** : Claude si l'application est en ligne **et** Claude disponible, sinon Ollama.
  La réponse affiche toujours le moteur effectivement utilisé (« 1 proposition · Claude »).
- Pastilles d'état dans l'en-tête : « Ollama » et « Claude » (vert = disponible, gris = indisponible ou hors ligne), info-bulle avec le détail.
- Sous le choix du moteur, une ligne bouclier dit **exactement ce qui est envoyé** quand Claude répond :
  - Viz : noms de colonnes, statistiques et 5 lignes d'exemple du jeu (si « Joindre le schéma ») ;
  - Tab : la demande, et les cellules que l'assistant lit avec ses outils (contenu des tables) ;
  - Projets : le texte de la story ou de l'élément, et pour le journal les messages et diffs des commits liés (tronqués à `AI_MAX_DIFF_CHARS`).

### 5.3 Appel de Claude
- Par la **CLI Claude Code** de la machine (abonnement de l'utilisateur), lancée **isolée**, comme dans Viz :
  `claude -p --safe-mode --output-format json --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence --max-turns <n> --model <alias> --system-prompt <prompt>`
  (+ `--json-schema <schéma>` pour une sortie structurée), conversation sur l'entrée standard, dossier de travail temporaire vide,
  délai maximal (180 s par défaut ; arrêt forcé si le processus ne s'arrête pas), sortie lue avec une taille maximale.
- **Aucune donnée en argument** de ligne de commande (visible par `ps`) : le prompt système ne contient que des consignes ;
  les données (lignes d'exemple, contenu de tables, diffs) passent par l'entrée standard.
- **Environnement en liste blanche** : `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TZ`, `CLAUDE_CONFIG_DIR`,
  plus `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Rien d'autre (ni `ANTHROPIC_*`, ni `CLAUDE_CODE_USE_BEDROCK/VERTEX`, ni secret de l'application).
  Le dossier de l'exécutable est placé en tête du `PATH` (une CLI installée par npm doit trouver `node` depuis le Finder).
- **Jamais d'outil de la CLI** (ni shell, ni fichiers, ni MCP). Quand une application a besoin d'actions (outils de l'assistant de Tab),
  c'est l'application qui les exécute : Claude répond en JSON contraint par `--json-schema`
  (`{"action":"tool","name":…,"arguments":{…}}` ou `{"action":"answer","text":…}`), l'application exécute l'outil par ses actions habituelles
  et renvoie le résultat au tour suivant (8 tours maximum par demande).
- Recherche de l'exécutable : variable `CLAUDE_CLI` (chemin absolu), sinon `PATH` — en ignorant les entrées relatives et les dossiers `node_modules/.bin` —,
  puis `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` (une app lancée depuis le Finder n'hérite pas du `PATH` du terminal).
  Le chemin retenu est absolu.
- Disponibilité : exécutable trouvé **et** `claude auth status` réussi (mis en cache 60 s ; une revérification forcée au plus toutes les 10 s). Version affichée dans les réglages.

### 5.4 Outils pilotés par une IA
Ce que lisent les outils (cellules, titres, commits) est une **donnée, jamais une instruction** :
- le prompt système le dit explicitement, et chaque résultat d'outil est transmis comme un bloc délimité « Résultat d'outil (données) », jamais comme un message de l'utilisateur ;
- un outil appelé par l'assistant **ne peut pas envoyer de données hors de la machine** sans confirmation de l'utilisateur dans l'interface
  (Tab : `configure_export` / `export_table` limités aux adresses de bouclage, toute autre adresse demande confirmation ; un jeton d'accès n'est envoyé qu'à l'adresse d'import d'Atelier Projets) ;
- hors ligne, aucun envoi vers une adresse extérieure, par aucun chemin ;
- les outils destructeurs (suppression de lignes, de colonnes, de tables) appelés par l'assistant demandent une confirmation.
- Le lancement d'une **session interactive** Claude Code dans un terminal (Projets : « Claude CLI sur … ») reste une fonction distincte, indépendante du moteur.

---

## 6. Vérification
Chaque dépôt garde ses contrôles (tests, typage, build). Toute évolution de ce contrat ajoute un test côté producteur **et** côté consommateur.
