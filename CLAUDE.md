# CLAUDE.md — Atelier Viz (BI locale)

Instructions permanentes pour Claude lorsqu'il travaille sur ce dépôt.
La spécification est dans `specification.md` : la lire avant toute nouvelle fonctionnalité.

## Rôle
Tu es l'architecte et le lead developer d'un **outil de BI local dans l'esprit de Power BI** :
import de données, rapports multi-pages, 22 types de visuels, segments, filtres, filtrage croisé,
cartes hors ligne, boutons d'automatisation, assistant IA (Ollama local ; Claude en mode « En ligne »).

## Principe n°1 : local d'abord
- Hors ligne par défaut : **rien ne quitte la machine** (données, calculs, fonds de carte, polices).
- API locale seulement : `LocalOnlyMiddleware` (`app/core/local_only.py`, docs/SUITE.md §5.1) refuse un `Host` non local (hors `ALLOWED_HOSTS`) et, pour les écritures, une `Origin` étrangère ou `null`. Ne jamais l'affaiblir : en test, `conftest` ajoute `testserver` à `allowed_hosts` ; un nouveau client (proxy, fenêtre) doit envoyer un Host de bouclage. `fastapi>=0.132` (corps JSON exigeant un `Content-Type` JSON).
- Toute fonctionnalité qui contacte Internet (Claude, webhook externe…) doit vérifier `online_mode`
  (`PreferencesStore`) et être refusée proprement hors ligne (HTTP 403 + message en français).
- Aucune ressource externe au chargement du frontend (pas de CDN, pas de Google Fonts).

## Stack
| Couche | Choix |
|---|---|
| Frontend | React 19 + TypeScript strict + Vite, Tailwind v4, Recharts 3, d3-geo + topojson, zustand (canvas libre maison) |
| Backend | FastAPI, Pydantic v2, pydantic-settings, httpx |
| Moteur | DuckDB (fichier `backend/data/atelier.duckdb`) : une table `ds_<id>` par jeu + `__datasets` (profils) |
| Import | pandas + openpyxl (CSV FR/EN, XLSX, JSON) |
| Rapports | Fichiers JSON `backend/data/reports/<id>.json` (écriture atomique) |
| IA | `AIService` → Ollama / Claude (`ClaudeCliProvider` via `claude -p`, ou `AnthropicProvider` selon `CLAUDE_MODE`) |

## Arborescence (repères)
```
backend/
  main.py                     # create_app() ; lifespan : préférences, DuckDB, rapports, IA
  app/schemas/                # ai, dataset, query (langage de requête), report
  app/services/engine/        # database.py (DuckDB + verrou), query.py (QueryRequest → SQL paramétré), expressions.py (langage des calculs)
  app/services/data/          # parsing, profiling, store (persistance DuckDB), model (colonnes / mesures calculées), context (contexte IA)
  app/services/reports.py     # ReportRepository (JSON)
  app/services/preferences.py # mode en ligne (fusion + écriture sous un même verrou)
  app/services/actions.py     # webhooks des boutons (et des alertes) ; hors ligne : connexion à l'IP privée validée (anti DNS rebinding)
  app/services/refresh.py     # RefreshScheduler : actualisation planifiée, journal (data/schedules.json)
  app/services/alerts.py      # AlertService : alertes sur seuil, anti-rebond, notifications (data/alerts.json)
  app/services/github.py      # GitHubSync : envoi / récupération des rapports (data/github.json)
  app/services/connectors/    # sources externes : sql (SQL Server, PostgreSQL, MySQL, SQLite), sharepoint (Graph), secrets, service
  app/services/ai/            # ollama, claude_cli, anthropic, service (routage + mode hors ligne)
  tests/                      # pytest — data_dir temporaire par test, aucun réseau ni CLI réels
frontend/src/
  theme/                      # thèmes de rapport, styles de visuels, couleurs hex
  visuals/registry.ts         # ★ catalogue des visuels : rôles, options, requête, composant
  visuals/types.ts            # contrat VisualDef / VisualProps
  visuals/common.tsx          # requête générique, couleurs, info-bulles, sélection
  visuals/{charts,data,maps,interactive}/
  studio/                     # StudioPage, Canvas, VisualContainer, store (zustand), filters, starter, bookmarks, ExportDialog, panes/
  export/                     # export PowerPoint : plan, données, captures, descripteurs, écriture pptxgenjs
  features/                   # reports (accueil), data (import), automation (planifications, alertes), settings (+ GitHub), assistant
  lib/api.ts, lib/router.ts   # client HTTP typé, routeur par hash
  types/                      # miroirs TypeScript des schémas Pydantic
samples/                      # ventes_2026.csv, magasins.csv (avec coordonnées)
```

## Ajouter un type de visuel
1. Ajouter le type au `Literal` `VisualType` (`backend/app/schemas/report.py`) et à `frontend/src/types/report.ts`.
2. Écrire le composant (`VisualProps`) dans `frontend/src/visuals/…`.
3. Ajouter l'entrée dans `VISUALS` (`registry.ts`) : rôles, options, `query` (souvent `genericQuery`).
4. Mettre à jour le test du registre (`logic.test.ts`) et la spec §5.
5. Export PowerPoint : entrée dans `BUILDERS` (natif) ou `IMAGE_ONLY` (`frontend/src/export/buildVisual.ts`).

## Placement des visuels
- Page en pixels (`Page.size`, 1280 × 720 par défaut) ; `Visual.layout` en px de page. Géométrie pure dans `studio/grid.ts` (migration des anciens rapports en grille, bornage, hauteur) et `studio/snap.ts` (déplacement, redimensionnement, repères), testée dans `studio/placement.test.ts`.
- Toute lecture d'un rapport potentiellement ancien passe par `migratePage` (le Studio le fait dans `load`, l'export dans `planSlides`).
- Le zoom met la page à l'échelle par `transform: scale` : une info-bulle maison positionnée à la souris utilise `localPoint` (`visuals/common.tsx`).

## Connecteurs
- `app/services/connectors/` : `ConnectionService` (registre `data/connections.json` sans secret, import, actualisation), `sql.py` (dialectes), `sharepoint.py` (Graph, code d'appareil), `secrets.py` (trousseau, sinon fichier 0600).
- Jamais de secret dans `connections.json`, les journaux ou les réponses API. Tests : `secrets_backend="file"`.
- Politique réseau : `check_server` (hors ligne = machine / réseau privé) ; SharePoint exige le mode en ligne (403) ; Atelier Projets : `check_loopback` (bouclage uniquement, quel que soit le mode, redirections jamais suivies).
- Requête libre : `check_query` (une instruction SELECT / WITH) + lecture seule côté serveur. Les types de la base sont gardés (`rows_to_frame`, pas d'`infer_types`).
- Un jeu importé garde `origin` ; `DatasetStore.replace_data` actualise en revalidant le modèle. Côté front, `refreshDataset` puis les visuels se rechargent (`invalidateQueries`).
- Pilotes facultatifs (`requirements-connectors.txt`) : `Dialect.driver_installed` et message 501 si absent.

## Suite Atelier
- Contrat commun avec Atelier Tab et Atelier Projets : **`docs/SUITE.md`** (identique dans les trois dépôts ; toute modification se fait dans les trois). Le lire avant de toucher au design, au thème, à la navigation ou aux échanges de données.
- Design system : `frontend/src/styles/atelier-ds/` = copies **verbatim** (ne jamais les modifier ici) ; les jetons d'habillage de `index.css` en dérivent. La palette de données et les thèmes de rapport restent hors du design system.
- Charte « néon monochrome » (docs/SUITE.md §1.7) : `styles/atelier-brand/atelier-brand.css` = copie **verbatim** (jamais modifiée ici) ; `data-atelier-app="viz"` sur `<html>` → toute l'interface dérive du jaune `#F2C811`, en clair comme en sombre (aucun bleu nuit ni cyan). Les jetons d'habillage de `index.css` (`--bg`, `--sidebar`, `--surface(-2|-3)`, `--field`, `--border` = trait doux, `--border-strong`, `--line`, `--fg`, `--muted`, `--accent*`) sont branchés sur les jetons `--atelier-*` ; fond de page `background: var(--atelier-backdrop), var(--bg)` (jamais en `background-image`). Texte / icône en couleur : `text-accent-ink` (jamais `text-accent` dans l'interface) ; fond actif `bg-accent-soft`, survol `bg-accent-faint` ; champs `bg-field`. Classes : cartes `atelier-card`, menus / popovers / modales `atelier-pop`, bouton principal `atelier-btn-primary` (plein en clair, contour néon en sombre), navigation active `atelier-nav-active`, titre `atelier-title`. Le contenu du rapport (`visuals/`, `Canvas`, `VisualContainer`) garde les couleurs du thème de rapport.
- Thème : `useTheme` pose `class="dark"` **et** `data-theme`. Sélecteur de suite : `lib/suite.ts` + `components/layout/SuiteSwitcher.tsx` (Viz, Tab, Projets et Atelier Cuisine, app en ligne jamais sondée ; ouverture par `DesktopApi.open_external` → `suite_bundle_for`).
- Données : enveloppes DataFlow (`app/services/data/dataflow.py`), connecteurs `atelier_tab` / `atelier_projets` (`app/services/connectors/atelier.py`, sans secret). Tests : `test_dataflow.py`, `test_connections_atelier.py` (transport httpx simulé).

## Partage et automatisation (jalon 6)
- **Signets** : capture / application pures dans `studio/bookmarks.ts` ; tout nouvel état de visuel « à retenir » (comme `options.selected`, `options.drill`) s'ajoute à `BookmarkVisualState` (schéma + miroir TS + `captured`). Appliquer un signet n'entre pas dans l'historique. `report.bookmarks` est facultatif : toujours lire `r.bookmarks ?? []`.
- **Ordonnanceur** : une seule exécution par jeu (`RefreshScheduler.run`) ; toute actualisation (manuelle comprise) passe par lui pour être journalisée. Horloge injectable : les tests appellent `tick()` sans attendre ; `conftest` coupe l'ordonnanceur réel (`scheduler_enabled=False`).
- **Après actualisation** : abonner un observateur (`scheduler.on_refreshed`) plutôt que d'appeler un service depuis `connectors/service.py`. Côté front, `useDataVersions` (interrogation de `/api/refresh/versions`) recharge profils et visuels ; `onDatasetRefreshed` pour les écrans qui listent des jeux.
- **Alertes** : la mesure est une `Measure` + `Filter` du langage de requête, évaluée par `run_query` — jamais d'expression ni de SQL propre aux alertes. Déclenchement au franchissement seulement (`Alert.met`).
- **GitHub** : rapports uniquement (jamais `data/` hors `reports/`) ; un rapport recopie des valeurs des données : tout nouveau champ de rapport qui en contient (ou un secret) s'ajoute à `services/report_privacy.py` (retrait à l'envoi, conservation locale à la récupération, testés) ; jeton au trousseau (`github:token`) ; un commit par envoi via l'API Git Data, mise à jour de branche sans `force` ; conflit = sha de blob distant ET local changés depuis `SyncRecord` → jamais d'écrasement sans `resolutions`. Tests : `FakeGitHub` (`httpx.MockTransport`) ; `conftest` ignore `GITHUB_TOKEN`.
- Boîte de dialogue ouverte depuis un visuel : `createPortal` vers `document.body` et `stopPropagation` (sinon le zoom du canvas et la sélection du visuel interfèrent).

## Application de bureau
- `backend/desktop.py` → `app/desktop.py` (pywebview + uvicorn en fil) ; paquet macOS : `scripts/macos/build_app.sh`. L'interface compilée est servie par FastAPI (`settings.frontend_dist`).
- Lanceur : **jamais de `npm install` au lancement** ; `app/launcher.py` (`ok` / `build` / `install`, testé dans `test_launcher.py`) décide d'un `npm run build` ou d'un message « relancez build_app.sh ».
- Front : tout enregistrement de fichier passe par `saveFile` et tout lien externe par `openExternal` (`lib/desktop.ts`) — jamais `a.download` ni `window.open` directement (WKWebView les ignore).
- Requêtes vers le serveur local sans proxy (`_local` dans desktop.py : macOS applique sinon le proxy système).

## Règles de code
1. **Modularité** : routes minces, logique dans `services/` ; un visuel = un composant + une entrée de registre.
2. **Typage strict** : TypeScript `strict` + `noUncheckedIndexedAccess`, pas de `any` ; Pydantic pour tout ce qui traverse l'API.
3. **Docstrings / JSDoc en français** sur les fonctions publiques.
4. **Contrat API** : tout schéma Pydantic a son miroir dans `frontend/src/types/`. Clés de colonnes identiques des deux côtés : dimension `champ` ou `champ|période`, mesure `agg(champ)`, calcul rapide `agg(champ)@kind` (`ShowAs.suffix` / `showSuffix`).
5. **Moteur** : jamais de SQL venant du client ; champs validés contre le profil, identifiants via `quote_ident`, valeurs en paramètres liés.
6. **Code bloquant** (pandas, DuckDB, disque, sous-processus) : `asyncio.to_thread`.
7. **Tests** : chaque endpoint a un test pytest ; la logique front (pivot, filtres, gabarits, placement des champs) a des tests Vitest. Les tests forcent `claude_mode="api"` sans clé.
8. **Configuration** : jamais de secret en dur ; tout passe par `app/core/config.py` et `.env`.

## Modélisation
- Expressions des colonnes / mesures calculées : `app/services/engine/expressions.py` (lexer → parseur → compilation typée). **Ne jamais** concaténer une expression utilisateur dans du SQL : tout passe par ce compilateur.
- Colonnes calculées : vue `v_<id>` (`StoredDataset.source`) ; toute requête lit `dataset.source`, jamais `dataset.table` directement. Mesures : `agg = "calc"`, compilées à chaque requête (`model.measure_sql`).
- Exploration : tout code qui lit les rôles d'un visuel pour l'afficher (requête, composant, export, résumé) part de `drillView(visual)`.

## Règles IA
- `provider = "ollama" | "anthropic" | "auto"` ; hors ligne, `anthropic` → 403, `auto` → Ollama.
- Mode CLI : appels isolés (docs/SUITE.md §5.3 : `--safe-mode`, `--tools ""`, `--system-prompt`, `--no-session-persistence`, dossier vide). Ne jamais donner d'outils à la CLI.
  - Environnement en **liste blanche** (`cli_environment`), dossier de l'exécutable en tête du `PATH` ; exécutable absolu (`find_claude_cli` : `CLAUDE_CLI` relatif refusé, `PATH` sans entrée relative ni `node_modules/.bin`).
  - **Aucune donnée en argument** : le prompt système ne contient que des consignes ; schéma, lignes, titres, faits vont dans les messages (entrée standard), en `data_block` (`<donnees>…</donnees>`) avec `DATA_RULE` dans le prompt système. Énumération tirée des données dans un schéma JSON : marque `DATA_ENUM` (retirée de `--json-schema`).
  - Sous-processus par `run_bounded` (sortie ≤ 4 Mo, délai puis SIGTERM/SIGKILL du groupe) ; tests : `runner` simulé, jamais la vraie CLI.
  - Cache : état 60 s, CLI absente recherchée de nouveau au plus toutes les 60 s, `invalidate` (`?refresh=true`) au plus toutes les 10 s.
- Seuls le **schéma** et **5 lignes** partent vers l'IA, et seulement si l'utilisateur coche « Joindre le schéma ».
- Création de visuels : `app/services/ai/builder.py` (schéma contraint → `repair` → une relance max). Le catalogue vient du registre frontend (`visuals/catalog.ts`) : ne pas le dupliquer côté backend. Tout visuel qui arrive au Studio est passé par `repair`.
- Tout fournisseur implémente `chat` et `chat_json` (sortie structurée).
- Résumé de page : les faits sont calculés côté frontend (`summary/facts.ts`), écrits comme à l'écran ; `app/services/ai/summary.py` vérifie chaque nombre de la réponse contre ces faits (relance, puis retrait). Ne jamais envoyer de lignes brutes ; tout nouveau type de fait doit rester lisible par `numbers()`.

## Export PowerPoint
- `frontend/src/export/` : tout se passe dans le navigateur (pptxgenjs chargé à la demande) ; aucune donnée envoyée.
- Chaîne : `exportReport.ts` (plan, données, captures) → `buildVisual.ts` (visuel → descripteurs `items.ts`, testables) → `writer.ts` (seul module qui appelle pptxgenjs).
- Nouveau type de visuel : l'ajouter à `BUILDERS` (natif) ou à `IMAGE_ONLY` (capture) dans `buildVisual.ts`, avec un test dans `export.test.ts`.
- Pièges pptxgenjs : couleurs sans « # » (`pptColor`), options jamais partagées (le writer clone), pas d'étiquette `outEnd` sur un empilé, pas d'axe secondaire (et jamais de double axe), `isTextBox` sur les textes.
- Après une modification : exporter la galerie, `python scripts/office/validate.py` (skill pptx) puis contrôler le rendu.

## Thèmes
- `frontend/src/theme/` : `color.ts` (hex, mélange, contraste WCAG), `reportTheme.ts` (préréglages, `themeVars`, `visualCss`, import Power BI), `ColorInput.tsx`.
- Un thème = des variables CSS : racine du rapport (`themeVars`) puis visuel (`visualCss`). Ne jamais lire une couleur de thème en JS dans un graphique : utiliser `var(--…)`.
- Tout nouveau préréglage : palette vérifiée avec le validateur dataviz sur son fond, texte ≥ 4,5:1 (test `theme.test.ts`).

## Design et dataviz
- Inspiration Power BI (canvas + volets Filtres / Visualisations / Données, onglets de pages en bas) et Vercel (sobre).
- Couleurs uniquement via les tokens de `src/index.css` (`--series-1..8`, `--seq-*`, `--div-*`), versions claire et sombre distinctes.
- Palette catégorielle en ordre fixe, 8 séries max puis « Autres » ; 3 max pour nuages / cartes à points.
- **Jamais de double axe.** Info-bulle sur tout graphique. Légende dès 2 séries. Texte en encre neutre, pas en couleur de série.
- Toute modification visuelle se vérifie en capture d'écran (clair + sombre).

## Commandes
```bash
# Backend (depuis backend/)
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn main:app --reload          # http://localhost:8000/docs
pytest && ruff check .

# Frontend (depuis frontend/)
npm install
npm run dev                        # http://localhost:5173 (proxy /api → :8000)
npm test && npm run build
```

## Façon de travailler
- Avant une fonctionnalité : plan court (fichiers, schémas), puis code.
- Après : `pytest`, `ruff check`, `npm test`, `npm run build`, puis vérification visuelle dans le navigateur.
- Mettre à jour `specification.md` (Roadmap) à chaque jalon terminé.
