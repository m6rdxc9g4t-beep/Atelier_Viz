# CLAUDE.md — Atelier Viz (BI locale)

Instructions permanentes pour Claude lorsqu'il travaille sur ce dépôt.
La spécification est dans `specification.md` : la lire avant toute nouvelle fonctionnalité.

## Rôle
Tu es l'architecte et le lead developer d'un **outil de BI local dans l'esprit de Power BI** :
import de données, rapports multi-pages, 22 types de visuels, segments, filtres, filtrage croisé,
cartes hors ligne, boutons d'automatisation, assistant IA (Ollama local ; Claude en mode « En ligne »).

## Principe n°1 : local d'abord
- Hors ligne par défaut : **rien ne quitte la machine** (données, calculs, fonds de carte, polices).
- Toute fonctionnalité qui contacte Internet (Claude, webhook externe…) doit vérifier `online_mode`
  (`PreferencesStore`) et être refusée proprement hors ligne (HTTP 403 + message en français).
- Aucune ressource externe au chargement du frontend (pas de CDN, pas de Google Fonts).

## Stack
| Couche | Choix |
|---|---|
| Frontend | React 19 + TypeScript strict + Vite, Tailwind v4, Recharts 3, d3-geo + topojson, react-grid-layout 2, zustand |
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
  app/services/engine/        # database.py (DuckDB + verrou), query.py (QueryRequest → SQL paramétré)
  app/services/data/          # parsing, profiling, store (persistance DuckDB), context (contexte IA)
  app/services/reports.py     # ReportRepository (JSON)
  app/services/preferences.py # mode en ligne
  app/services/actions.py     # webhooks des boutons
  app/services/ai/            # ollama, claude_cli, anthropic, service (routage + mode hors ligne)
  tests/                      # pytest — data_dir temporaire par test, aucun réseau ni CLI réels
frontend/src/
  theme/                      # thèmes de rapport, styles de visuels, couleurs hex
  visuals/registry.ts         # ★ catalogue des visuels : rôles, options, requête, composant
  visuals/types.ts            # contrat VisualDef / VisualProps
  visuals/common.tsx          # requête générique, couleurs, info-bulles, sélection
  visuals/{charts,data,maps,interactive}/
  studio/                     # StudioPage, Canvas, VisualContainer, store (zustand), filters, starter, ExportDialog, panes/
  export/                     # export PowerPoint : plan, données, captures, descripteurs, écriture pptxgenjs
  features/                   # reports (accueil), data (import), settings, assistant
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

## Règles de code
1. **Modularité** : routes minces, logique dans `services/` ; un visuel = un composant + une entrée de registre.
2. **Typage strict** : TypeScript `strict` + `noUncheckedIndexedAccess`, pas de `any` ; Pydantic pour tout ce qui traverse l'API.
3. **Docstrings / JSDoc en français** sur les fonctions publiques.
4. **Contrat API** : tout schéma Pydantic a son miroir dans `frontend/src/types/`. Clés de colonnes identiques des deux côtés : dimension `champ` ou `champ|période`, mesure `agg(champ)`.
5. **Moteur** : jamais de SQL venant du client ; champs validés contre le profil, identifiants via `quote_ident`, valeurs en paramètres liés.
6. **Code bloquant** (pandas, DuckDB, disque, sous-processus) : `asyncio.to_thread`.
7. **Tests** : chaque endpoint a un test pytest ; la logique front (pivot, filtres, gabarits, placement des champs) a des tests Vitest. Les tests forcent `claude_mode="api"` sans clé.
8. **Configuration** : jamais de secret en dur ; tout passe par `app/core/config.py` et `.env`.

## Règles IA
- `provider = "ollama" | "anthropic" | "auto"` ; hors ligne, `anthropic` → 403, `auto` → Ollama.
- Mode CLI : appels isolés (`--safe-mode`, `--tools ""`, `--system-prompt`, `--no-session-persistence`, dossier vide, `ANTHROPIC_API_KEY` retirée). Ne jamais donner d'outils à la CLI.
- Seuls le **schéma** et **5 lignes** partent vers l'IA, et seulement si l'utilisateur coche « Joindre le schéma ».
- Création de visuels : `app/services/ai/builder.py` (schéma contraint → `repair` → une relance max). Le catalogue vient du registre frontend (`visuals/catalog.ts`) : ne pas le dupliquer côté backend. Tout visuel qui arrive au Studio est passé par `repair`.
- Tout fournisseur implémente `chat` et `chat_json` (sortie structurée).

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
