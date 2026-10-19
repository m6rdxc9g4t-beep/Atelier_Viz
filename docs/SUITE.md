# Suite Atelier — contrat commun

Ce document est **identique** dans les trois dépôts (`Atelier_Viz`, `atelier-tab`, `Atelier_Projets`), sous `docs/SUITE.md`.
Il fixe ce que les trois applications partagent : identité visuelle, ports, navigation, échanges de données.
Toute modification se fait dans les trois dépôts à la fois.

| Application | Rôle | Stack |
|---|---|---|
| **Atelier Viz** | BI locale (rapports, visuels, IA) | FastAPI + DuckDB · React |
| **Atelier Tab** | Tableur + base typée | React · Electron (bureau) |
| **Atelier Projets** | Projets agiles, Git, temps passé | Fastify + Prisma/SQLite · React |

Principes partagés : **local d'abord** (rien ne quitte la machine hors ligne), interface **en français**, IA locale par Ollama (`http://localhost:11434`), clair + sombre.

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
| Accent (onglet actif, focus, bouton principal) | `--accent` = `--type-epic` (#8250DF) | `--accent` | `--accent` |
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
Les six applications Atelier (Projets, Viz, Tab, Ciné, Savoir, Trésorerie) affichent leur marque de la même façon,
comme sur leurs logos : tuile au dégradé cyan avec icône Lucide blanche, puis `atelier_` atténué et le nom en gras.

- Source : `Atelier_Projets/design-system/brand/` (`atelier-brand.css`, police Nunito variable embarquée, licence OFL).
  Copies verbatim : `frontend/src/styles/atelier-brand/` (Viz), `src/styles/atelier-brand/` (Tab),
  `frontend/src/brand/` (Ciné), `static/brand/` (Savoir, Trésorerie).
- Balisage : `button.atelier-brand` > `.atelier-brand__tile` (icône) + `.atelier-brand__name` > `.atelier-brand__prefix` (« atelier_ ») + nom.
- Icônes : Projets `calendar-check`, Viz `chart-column`, Tab `table-2`, Ciné `play`, Savoir `graduation-cap`, Trésorerie `landmark`.
- La police de marque ne sert qu'à la marque ; le reste de l'interface garde la pile système.
- Clic sur la marque : fenêtre « À propos » (`<dialog class="atelier-about">`) avec le logo complet de l'application en grand, son nom et une phrase de présentation. Identique partout, toujours sombre.
- Icônes : l'icône d'application (Dock, `.app`, Electron) est le logo complet ; le favicon (`favicon-64.png`, `apple-touch-icon.png`) est la tuile de l'étiquette du logo.

---

## 2. Ports et adresses

| Application | Interface (dev) | Interface (aperçu / app) | API |
|---|---|---|---|
| Atelier Viz | `http://127.0.0.1:5173` | `http://127.0.0.1:8000` (servie par FastAPI) | `http://127.0.0.1:8000/api` |
| Atelier Projets | `http://127.0.0.1:5174` | `http://127.0.0.1:4174` | `http://127.0.0.1:3000/api` |
| Atelier Tab | `http://127.0.0.1:5175` | `http://127.0.0.1:4175` · app Electron | — |

`strictPort: true` sur chaque serveur Vite : en cas de conflit, échec explicite plutôt qu'un port au hasard.

---

## 3. Navigation dans la suite

Chaque en-tête d'application porte un **sélecteur « Suite Atelier »** (icône grille, à gauche du nom de l'app) :
- trois entrées : Atelier Viz (icône `BarChart3`), Atelier Tab (`Table2`), Atelier Projets (`KanbanSquare`), avec une ligne de description ;
- l'application courante est cochée ;
- un clic ouvre l'adresse de l'application (colonne « Interface (aperçu / app) » ci-dessus) dans le navigateur
  (dans une app de bureau : par le mécanisme d'ouverture externe de l'app — `openExternal` dans Viz, `shell.openExternal` dans Tab) ;
- un indicateur « en marche / arrêtée » est affiché pour les apps qui ont une API (`GET /api/health`, délai 1,5 s, sans bloquer le menu).

Les adresses sont des constantes dans un module dédié (`suite.ts`), surchargeables par variables d'environnement Vite
(`VITE_ATELIER_VIZ_URL`, `VITE_ATELIER_TAB_URL`, `VITE_ATELIER_PROJETS_URL`, et, dans Tab, `VITE_ATELIER_PROJETS_API_URL` pour l'adresse de santé de Projets).
Dans une app, l'état de l'app courante se vérifie sur sa propre origine (`/api/health`), pas à l'adresse fixe.

Nom affiché : **Atelier Viz**, **Atelier Tab**, **Atelier Projets** (avec une espace) dans les titres et en-têtes.
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

## 5. Vérification
Chaque dépôt garde ses contrôles (tests, typage, build). Toute évolution de ce contrat ajoute un test côté producteur **et** côté consommateur.
