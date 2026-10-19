# Atelier Viz

Outil de Business Intelligence **local**, dans l'esprit de Power BI : import de données, rapports
multi-pages, 22 types de visuels, segments, filtres, filtrage croisé, cartes hors ligne, boutons
d'automatisation (URL, webhooks), assistant IA — avec un interrupteur **« En ligne »** pour activer Claude.

- Spécification : [`specification.md`](specification.md)
- Conventions pour Claude : [`CLAUDE.md`](CLAUDE.md)

## Démarrage

```bash
# 1. Backend
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows : .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn main:app --reload                              # http://localhost:8000/docs

# 2. Frontend
cd frontend
npm install
npm run dev                                            # http://localhost:5173

# 3. Optionnel — IA
ollama serve && ollama pull llama3.2                   # IA locale
claude auth login && claude update                     # Claude (mode « En ligne »), avec votre compte claude.ai
```

Premier essai : **Données → Parcourir…** → `samples/ventes_2026.csv` (et `samples/magasins.csv`),
puis **Rapports → Rapport de démarrage**.

Les données vivent dans `backend/data/` (base DuckDB, rapports JSON, réglages) : sauvegardez ce dossier.

## Dans le Studio

| Action | Comment |
|---|---|
| Ajouter un visuel | Icône du volet Visualisations, ou clic sur un champ du volet Données |
| Configurer | Glisser des champs dans les puits (Axe, Légende, Valeurs…) ou directement sur le visuel |
| Changer de type | Sélectionner le visuel puis cliquer une autre icône (les champs sont conservés) |
| Filtrer | Segments, volet Filtres (page / visuel), clic sur un élément d'un graphique (filtrage croisé) |
| Automatiser | Visuel « Bouton d'action » : URL avec `{champ}`, webhook (n8n, Make, Zapier), page, réinitialisation |
| Habiller | Bouton « Thème » : clair / sombre, préréglages (Verre, Papier, Minuit…), couleurs en hexadécimal, import de thèmes Power BI ; onglet Format d'un visuel : fond transparent, bordure, arrondi, ombre, titre, couleurs |
| Raccourcis | Ctrl+Z / Ctrl+Y, Ctrl+D, Suppr, Échap |

## Tests

```bash
cd backend && pytest && ruff check .          # 71 tests
cd frontend && npm test && npm run build      # 34 tests
```

## Arborescence

```
atelier-viz/
├── CLAUDE.md · specification.md · README.md
├── samples/                      # ventes_2026.csv (573 ventes), magasins.csv (30 magasins géolocalisés)
├── backend/
│   ├── main.py
│   └── app/
│       ├── api/routes/           # health, settings, ai, datasets, query, reports, actions
│       ├── schemas/              # ai, dataset, query, report
│       └── services/
│           ├── engine/           # DuckDB : stockage + requêtes (GROUPING SETS pour les matrices)
│           ├── data/             # import, typage, profilage
│           ├── ai/               # Ollama, Claude CLI, API Anthropic, routage hors ligne / en ligne
│           └── reports.py · preferences.py · actions.py
└── frontend/src/
    ├── visuals/                  # registre + 22 visuels (charts, data, maps, interactive)
    ├── studio/                   # canvas, volets, pages, état d'édition, filtres
    ├── features/                 # accueil rapports, données, réglages, assistant
    └── assets/geo/               # fonds de carte France (Licence Ouverte Etalab)
```

Fonds de carte : France régions et départements d'après [france-geojson](https://github.com/gregoiredavid/france-geojson)
(Admin Express, Licence Ouverte) ; monde d'après world-atlas (Natural Earth, domaine public).
