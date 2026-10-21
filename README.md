# Atelier Viz

Outil de Business Intelligence **local**, dans l'esprit de Power BI : import de données, rapports
multi-pages, 22 types de visuels, segments, filtres, filtrage croisé, cartes hors ligne, boutons
d'automatisation (URL, webhooks), assistant IA, **export PowerPoint modifiable**, signets, actualisation
planifiée, alertes sur seuil, rapports versionnés dans GitHub — avec un interrupteur **« En ligne »** pour
activer Claude.

- Spécification : [`specification.md`](specification.md)
- Conventions pour Claude : [`CLAUDE.md`](CLAUDE.md)
- Suite Atelier (contrat commun avec Atelier Tab et Atelier Projets) : [`docs/SUITE.md`](docs/SUITE.md)

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

Premier essai : **Rapports → Ouvrir l'exemple**. Les données d'exemple du dossier `samples/`
(`ventes_2026.csv` : 573 ventes ; `magasins.csv` : 30 magasins avec coordonnées ; `regions.csv` : 13 régions, reliées aux deux autres) sont importées et un rapport
de démonstration s'ouvre. On peut aussi les importer depuis **Données → Charger les données d'exemple**.

### Application Mac à double-cliquer

Une fois, depuis le dépôt et dans l'environnement Python du backend :

```bash
conda activate atelier            # ou : source backend/.venv/bin/activate
./scripts/macos/build_app.sh      # crée ~/Applications/Atelier Viz.app
```

Ensuite, **double-clic sur « Atelier Viz »** (Finder, Spotlight, ou le Dock : clic droit → Options → Garder
dans le Dock). L'application ouvre sa propre fenêtre : pas de terminal, pas de `npm run dev`. Fermer la
fenêtre (⌘Q) arrête tout.

- Même dépôt, mêmes données (`backend/data`) que le mode développement ; un seul des deux à la fois (la base n'accepte qu'un programme). Si un `uvicorn` tourne déjà, l'application le réutilise.
- Exports PowerPoint et thèmes : boîte « Enregistrer sous » ; liens externes (Microsoft 365, boutons URL) : navigateur par défaut.
- Après un `git pull` : l'application recompile l'interface à son lancement si les sources sont plus récentes
  (`npm run build`, sans réseau). Elle **n'installe jamais rien au lancement** : si les dépendances npm (ou Python)
  ont changé, un message vous invite à relancer `./scripts/macos/build_app.sh` ; l'ancienne interface reste utilisée en attendant.
- En cas de souci : `~/Library/Logs/Atelier Viz/atelier-viz.log`. Sans fenêtre native, `python desktop.py --browser` (dans `backend/`) ouvre l'application dans le navigateur.

### Activer Claude

1. Installez Claude Code : `curl -fsSL https://claude.ai/install.sh | bash` (ou `brew install --cask claude-code`),
   puis vérifiez dans un nouveau terminal : `claude --version`.
2. Connectez-vous avec votre compte claude.ai : `claude auth login`.
3. Rien d'autre à configurer : la commande `claude` est cherchée dans `CLAUDE_CLI` (chemin **absolu**, facultatif ;
   un chemin relatif est refusé), le `PATH` (hors entrées relatives et `node_modules/.bin`), puis `~/.local/bin`,
   `/opt/homebrew/bin` et `/usr/local/bin` — même quand l'application est lancée depuis le Finder. Installée pendant
   que l'application tourne, elle est retrouvée en moins d'une minute, ou au clic sur « Revérifier ».
   Chaque appel est isolé (docs/SUITE.md §5.3) : aucun outil, environnement réduit à une liste blanche (aucune clé ni
   secret), aucune donnée en argument de ligne de commande (tout passe par l'entrée standard), sortie et durée bornées.
4. Dans l'application, cliquez sur **Hors ligne** en haut à droite : il passe à **En ligne** et Claude devient
   sélectionnable (le voyant « Claude » passe au vert).
5. Là où l'on utilise l'IA : **Moteur Auto · Ollama · Claude** et le modèle (Claude : Sonnet, Opus ou Haiku ;
   Ollama : un modèle installé), mémorisés. « Auto » prend Claude en ligne quand il est disponible, sinon Ollama.

Les données vivent dans `backend/data/` (base DuckDB, rapports JSON, réglages, connexions, planifications
`schedules.json`, alertes `alerts.json`, dépôt GitHub `github.json`) : sauvegardez ce dossier.

### API locale seulement

L'API n'accepte que les requêtes de la machine : en-tête `Host` `127.0.0.1`, `localhost` ou `[::1]` (sinon 403), et
pour toute écriture une `Origin` absente ou locale — un site web ouvert dans le navigateur ne peut ni lire l'API (même
par DNS rebinding), ni passer Atelier Viz en ligne, ni appeler Claude. Pour joindre l'API sous un autre nom
(ex. `viz.local`), ajoutez-le à `ALLOWED_HOSTS=viz.local` dans `backend/.env`.

## Partage et automatisation

| Fonction | Où | À savoir |
|---|---|---|
| Signets | Studio → **Signets** | Retient la page, les filtres, les segments, la sélection et l'exploration ; un clic pour revenir à cet état. Un Bouton d'action peut « Appliquer un signet » |
| Actualisation planifiée | Données → **Planifier**, ou **Automatisation** | Jeux importés d'une connexion : toutes les N minutes / heures ou chaque jour à HH:MM, tant que l'application est ouverte. Journal des exécutions ; les rapports ouverts se mettent à jour seuls. SharePoint hors ligne : exécution sautée |
| Alertes | **Automatisation → Alertes**, ou cloche d'un KPI / d'une jauge | « Somme de chiffre_affaires < 150 000 » (filtres possibles), sur la valeur ou sa **variation** (« baisse de plus de 10 % depuis la dernière actualisation »), éventuellement **pour chaque** région : notification dans l'application (cloche de l'en-tête), **notification système** (centre de notifications du Mac) et / ou webhook (n8n, Make…), au franchissement du seuil, après chaque actualisation |
| GitHub | **Réglages → Synchronisation GitHub** | Mode « En ligne ». Dépôt `propriétaire/dépôt`, branche, dossier, jeton fine-grained (*Contents : read and write*) rangé au trousseau. **Envoyer** = un commit ; **Récupérer** = import, conflits jamais écrasés sans votre choix. **Seuls les rapports partent** (jamais les tables des jeux) ; option *Retirer les sélections, filtres et adresses de webhook avant l'envoi*, **activée par défaut**, car un rapport recopie des valeurs des données et l'adresse (souvent secrète) des webhooks ; avertissement si le dépôt est public. **Historique** d'un rapport (icône d'horloge) : versions, aperçu, **restauration** (ou en copie). **GitHub Enterprise** : adresse de l'API (`https://<hôte>/api/v3`) |

## Suite Atelier

Atelier Viz, **Atelier Tab** (tableur et base typée) et **Atelier Projets** (projets agiles, temps passé) partagent
le même design system, le même thème clair / sombre et se rejoignent par le sélecteur **Suite Atelier** (icône
grille, en haut à gauche) : il ouvre chaque application et indique si Atelier Tab et Atelier Projets sont en marche.
Il ouvre aussi **Atelier Cuisine** (stock, repas, courses et budget du foyer), app en ligne
(`https://atelier-cuisine-iota.vercel.app`) : jamais sondée, marquée « En ligne » ; depuis l'application de bureau,
son app Mac (`fr.ateliercuisine.app`) si elle est installée, sinon le navigateur par défaut.
Contrat commun : [`docs/SUITE.md`](docs/SUITE.md).

| Source | Comment |
|---|---|
| Atelier Tab | **Données → Se connecter à une source → Atelier Tab**. L'application de bureau Atelier Tab publie chaque table à son enregistrement dans `~/Atelier_Tab/exports` (dossier modifiable dans la connexion, ou `ATELIER_TAB_EXPORTS_DIR`). Choisir une table, **Importer** ; **Actualiser** relit la dernière version publiée. Instantané limité à 50 Mo (`ATELIER_TAB_MAX_SNAPSHOT_MB`). Un fichier `.json` exporté d'Atelier Tab (enveloppe DataFlow) peut aussi être importé directement : colonnes `_ligne`, `_id` puis une par champ, valeurs calculées, types gardés. |
| Atelier Projets | **Atelier Projets** dans la même liste : adresse `http://127.0.0.1:3000` par défaut (`ATELIER_PROJETS_URL`). Choisir un jeu (éléments de travail, temps passé, jalons) et, si besoin, un projet ; **Importer**, puis **Actualiser**. Atelier Projets doit être lancé sur cette machine (adresse `127.0.0.1`, `localhost` ou `::1` uniquement, même en mode « En ligne ») ; aucun mot de passe. |

Adresses des applications dans le sélecteur : `VITE_ATELIER_VIZ_URL`, `VITE_ATELIER_TAB_URL`, `VITE_ATELIER_PROJETS_URL`,
`VITE_ATELIER_CUISINE_URL` (fichier `frontend/.env.local`), par défaut celles de `docs/SUITE.md` §2.

## Connecteurs (SQL Server, PostgreSQL, MySQL, SQLite, OneDrive, SharePoint)

Page **Données → Se connecter à une source**. Une connexion est enregistrée une fois ; on choisit ensuite une
table, une requête `SELECT` ou une feuille, on voit un aperçu, puis **Importer** copie les données dans la base
locale (les rapports restent rapides et marchent hors ligne). **Actualiser** (page Données, ou volet Données du
Studio) relit la source : même jeu, mêmes rapports, mesures et colonnes calculées conservées.

```bash
# Pilotes des bases (dans l'environnement du backend ; n'installez que ceux utiles)
pip install -r requirements-connectors.txt     # pymssql (SQL Server), psycopg (PostgreSQL), pymysql (MySQL)
```

| Source | À savoir |
|---|---|
| SQL Server / Azure SQL | Serveur `sql01.entreprise.local` ou instance `serveur\INSTANCE` ; compte SQL ou Windows `DOMAINE\utilisateur` ; cocher « chiffrement » pour Azure SQL. Sur Mac, pymssql s'installe sur macOS 14 ou plus récent. |
| PostgreSQL, MySQL / MariaDB | Serveur, port, base, utilisateur. La session est ouverte **en lecture seule** par le serveur. |
| SQLite | Chemin du fichier `.db`, ouvert en lecture seule. |
| Fichier synchronisé | CSV, Excel (choix de la feuille) ou JSON d'un dossier **OneDrive / SharePoint / Teams synchronisé** (sur Mac : `~/Library/CloudStorage/OneDrive-<Entreprise>/…`) ou d'un partage réseau. Fonctionne hors ligne. |
| SharePoint Online | Fichier d'une bibliothèque (lien « Copier le lien ») ou **liste** SharePoint, avec votre compte Microsoft 365. Mode « En ligne » requis. |

- **Hors ligne**, seuls la machine et les réseaux privés (entreprise, VPN) sont joignables ; une base sur Internet demande le mode « En ligne ».
- **Mots de passe et jetons** : rangés dans le trousseau du système (Trousseau macOS…), jamais dans les fichiers de l'application ni renvoyés par l'API.
- **Lecture seule** : une requête libre doit être une seule instruction `SELECT` / `WITH` (pas de `INSERT`, `SELECT … INTO`, `;` au milieu…). Un compte limité à la lecture reste conseillé (`db_datareader`, `pg_read_all_data`…).

### Activer SharePoint Online (une fois, par l'administrateur Microsoft 365)

1. [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID → Inscriptions d'applications → Nouvelle inscription** : « Atelier Viz », comptes de cet annuaire uniquement.
2. **Authentification → Paramètres avancés → Autoriser les flux de clients publics : Oui.**
3. **Autorisations d'API → Microsoft Graph → Autorisations déléguées** : `Sites.Read.All`, `Files.Read.All` (+ `User.Read`, `offline_access`) ; accorder le consentement administrateur si l'entreprise l'exige.
4. Copier l'**ID d'application (client)** dans `backend/.env` : `SHAREPOINT_CLIENT_ID=…` et `SHAREPOINT_TENANT=entreprise.fr`, puis relancer `uvicorn`.
5. Passer en **En ligne**, créer une connexion SharePoint, **Se connecter à Microsoft 365** : saisir le code affiché sur microsoft.com/devicelogin.

Sans application Entra ID, un fichier SharePoint se lit quand même via **Fichier synchronisé** (bouton « Synchroniser » ou « Ajouter un raccourci à Mes fichiers » dans SharePoint).

## Dans le Studio

| Action | Comment |
|---|---|
| Ajouter un visuel | Icône du volet Visualisations, clic sur un champ du volet Données, ou **Créer avec l'IA** (« CA par région sur une carte ») |
| Configurer | Glisser des champs dans les puits (Axe, Légende, Valeurs…) ou directement sur le visuel |
| Placer au pixel près | Glisser la poignée du haut du visuel n'importe où sur la page (repères d'alignement roses, Alt pour s'en passer), 8 poignées pour la taille (Maj : proportions), flèches du clavier (1 px, Maj : 10 px), ou X / Y / L / H dans l'onglet Format ; superposer et choisir premier plan / arrière-plan ; taille de la page dans l'onglet Format sans sélection ; zoom en bas à droite (Ctrl + molette) |
| Changer de type | Sélectionner le visuel puis cliquer une autre icône (les champs sont conservés) |
| Filtrer | Segments, volet Filtres (page / visuel), clic sur un élément d'un graphique (filtrage croisé) |
| Extraire | Une page « Détail région » marquée page d'extraction (volet Visualisations, sans visuel sélectionné) ; clic droit sur une barre d'une autre page → **Extraire vers** : la page s'ouvre filtrée, bouton Retour |
| Présenter | Bouton **Présenter** : plein écran, flèches pour changer de page, diaporama automatique des pages ou des signets, Échap pour quitter |
| Automatiser | Visuel « Bouton d'action » : URL avec `{champ}`, webhook (n8n, Make, Zapier), page, réinitialisation |
| Comparer dans le temps | Puits Valeurs → **Afficher** : cumul depuis le début de l'année, N-1, écart et évolution vs N-1 (%), moyenne mobile, part du total — sans formule, sur n'importe quel visuel (KPI « +13,9 % vs N-1 ») |
| Calculer | Volet Données → **+ Mesure** (`SUM(chiffre_affaires * taux_marge / 100)`, `DIVIDE([Marge], SUM(chiffre_affaires))`) ou **+ Colonne** (`IF(chiffre_affaires >= 5000, "Grosse vente", "Standard")`), vérifiées à la frappe |
| Préparer | Page Données → **Préparer** : renommer, changer le type, filtrer, remplacer, remplir les vides, nettoyer le texte, supprimer les doublons, dépivoter, fractionner — étapes listées comme dans Power Query, aperçu à chaque étape, rejouées à chaque actualisation |
| Relier deux jeux | Volet Données → **Relier** : ventes → régions par la colonne `region` ; les colonnes des régions (`regions.responsable`…) s'utilisent dans les visuels des ventes, et un segment sur les régions filtre les ventes. Diagnostic des correspondances pendant la saisie |
| Explorer | Plusieurs champs dans l'Axe = hiérarchie ; flèches du visuel pour monter / descendre ; « Hiérarchie de dates » pour année › trimestre › mois |
| Mettre en évidence | Table ou matrice → onglet Format → **Mise en forme conditionnelle** : dégradé ou couleurs divergentes, règles (« < 900 000 → rouge »), barres de données, icônes ▲ ● ▼ |
| Habiller | Bouton « Thème » : clair / sombre, préréglages (Verre, Papier, Minuit…), couleurs en hexadécimal, import de thèmes Power BI ; onglet Format d'un visuel : fond transparent, bordure, arrondi, ombre, titre, couleurs |
| Demander | Bouton **Demander** : « Quelle région a le plus gros chiffre d'affaires ? » → un visuel calculé ici avec les filtres de la page et une réponse courte, chaque chiffre vérifié ; **Ajouter à la page**. Clic droit sur une valeur → **Expliquer cette valeur** : écart avec la période précédente (ou répartition comparée à l'ensemble) décomposé par dimension, puis rédigé par l'IA |
| Résumer | Bouton **Résumer** : synthèse de la page par l'IA, chaque chiffre vérifié contre les données ; à insérer dans la page ou dans les notes PowerPoint |
| Exporter | Bouton **Exporter** → **PowerPoint** (une page = une diapositive, graphiques et tableaux modifiables, filtres dans les notes), **PDF** (une page par page), **Image** PNG de la page, ou **Rapport HTML autonome** (un fichier lisible partout hors ligne, avec les données de chaque visuel) ; fichiers créés sur la machine |
| Raccourcis | Ctrl+Z / Ctrl+Y, Ctrl+D, Suppr, flèches, Échap |

## Tests

```bash
cd backend && pytest && ruff check .          # 320 tests
cd frontend && npm test && npm run build      # 170 tests
```

## Arborescence

```
atelier-viz/
├── CLAUDE.md · specification.md · README.md
├── samples/                      # ventes_2026.csv (573 ventes), magasins.csv (30 magasins géolocalisés), regions.csv (13 régions)
├── backend/
│   ├── main.py
│   └── app/
│       ├── api/routes/           # health, settings, ai, datasets, query, reports, actions, connections, refresh, alerts, github
│       ├── schemas/              # ai, dataset, query, report
│       └── services/
│           ├── engine/           # DuckDB : stockage + requêtes (GROUPING SETS pour les matrices)
│           ├── data/             # import, typage, profilage
│           ├── ai/               # Ollama, Claude CLI, API Anthropic, routage hors ligne / en ligne
│           ├── connectors/       # SQL, fichiers, SharePoint, secrets (trousseau)
│           └── reports.py · preferences.py · actions.py · refresh.py · alerts.py · github.py
└── frontend/src/
    ├── visuals/                  # registre + 22 visuels (charts, data, maps, interactive)
    ├── studio/                   # canvas, volets, pages, état d'édition, filtres
    ├── features/                 # accueil rapports, données, automatisation, réglages, assistant
    └── assets/geo/               # fonds de carte France (Licence Ouverte Etalab)
```

Fonds de carte : France régions et départements d'après [france-geojson](https://github.com/gregoiredavid/france-geojson)
(Admin Express, Licence Ouverte) ; monde d'après world-atlas (Natural Earth, domaine public).
