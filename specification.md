# Spécifications fonctionnelles et techniques — Atelier Viz

## 1. Vision
Un **outil de BI local, dans l'esprit de Power BI**, qui va plus loin sur l'automatisation :
- tout fonctionne **hors ligne** par défaut : données, calculs, rapports et fonds de carte restent sur la machine ;
- un interrupteur **« En ligne »** active Claude (via la CLI Claude Code et l'abonnement claude.ai) et les webhooks vers Internet ;
- des rapports multi-pages avec plus de 20 types de visuels, segments, filtres, filtrage croisé, cartes ;
- des **boutons d'automatisation** (URL paramétrées par les filtres, webhooks n8n / Make / Zapier, navigation) ;
- **export PowerPoint** : une page = une diapositive, graphiques et tableaux PowerPoint modifiables, généré sur la machine ;
- **partage et automatisation** : signets, actualisation planifiée des sources, alertes sur seuil, rapports versionnés dans un dépôt GitHub.

## 2. Architecture

```
┌────────────────────────────────────────┐   /api (JSON)   ┌──────────────────────────────────────────┐
│ Frontend React 19 + TS (Vite)          │ ──────────────▶ │ Backend FastAPI                           │
│ Studio : canvas libre (px, repères),   │                 │  routes → services                        │
│   volets Filtres / Visualisations /    │ ◀────────────── │  ├─ engine  : DuckDB (stockage + requêtes)│
│   Données, pages, annuler/rétablir     │                 │  ├─ data    : import pandas, profilage    │
│ Visuels : registre (Recharts, d3-geo)  │                 │  ├─ reports : fichiers JSON               │
│ Assistant IA                           │                 │  ├─ actions : webhooks                    │
└────────────────────────────────────────┘                 │  └─ ai      : Ollama / Claude (CLI ou API) │
                                                           └───────────────┬───────────────┬──────────┘
                                                      backend/data/        │               │ (mode en ligne)
                                                      atelier.duckdb       ▼               ▼
                                                      reports/*.json   Ollama :11434   claude -p
                                                      settings.json    (local)         (abonnement)
```

| Couche | Technologie | Rôle |
|---|---|---|
| Frontend | React 19, TypeScript strict, Vite, Tailwind v4, Recharts 3, d3-geo, zustand | Studio, visuels, cartes |
| Backend | FastAPI, Pydantic v2 | API, validation |
| Moteur | **DuckDB** (fichier local) | Stockage des jeux importés, agrégations SQL générées, GROUPING SETS |
| Import | pandas + openpyxl | CSV FR/EN, XLSX, JSON → typage → table DuckDB |
| Rapports | Fichiers JSON (`backend/data/reports/`) | Versionnables tels quels dans Git |
| IA locale | Ollama | Mode hors ligne |
| IA en ligne | Claude via `claude -p` (abonnement) ou API | Mode en ligne uniquement |

### Application de bureau

- `scripts/macos/build_app.sh` crée `~/Applications/Atelier Viz.app` (Info.plist, icône `scripts/macos/icon.png` → icns, lanceur qui fige le chemin du dépôt, l'interpréteur Python et le PATH).
- `backend/desktop.py` → `app/desktop.py` : serveur uvicorn dans un fil (127.0.0.1, port 8000 sinon un port libre), interface compilée servie par FastAPI (`frontend/dist`, montée après `/api`), fenêtre native pywebview (WKWebView sur macOS), stockage persistant, arrêt propre à la fermeture.
- Réutilise un serveur Atelier Viz déjà lancé ; refuse proprement si la base DuckDB est verrouillée par un autre processus (page d'erreur dans la fenêtre).
- Pont JavaScript `window.pywebview.api` : `save_file` (boîte « Enregistrer sous ») et `open_external` (http, https, mailto uniquement) ; côté front, `lib/desktop.ts` (`saveFile`, `openExternal`) bascule seul entre application et navigateur.

## 3. Principe hors ligne / en ligne

| | Hors ligne (défaut) | En ligne |
|---|---|---|
| Données, calculs, rapports | Locaux | Locaux |
| Fonds de carte | Empaquetés (France régions/départements, monde) | Idem |
| Polices | Pile système (aucune police téléchargée) | Idem |
| IA | Ollama uniquement ; Claude refusé (HTTP 403) | Ollama + Claude |
| Ce qui part vers l'IA | — | Schéma + 5 lignes, seulement si « Joindre le schéma » est coché |
| Boutons webhook | Adresses locales / réseau privé uniquement (nom résolu **une seule fois**, toutes ses adresses privées ; connexion à l'IP validée avec `Host` et vérification TLS sur le nom : pas de DNS rebinding) | Toute adresse http(s) |
| Connecteurs SQL | Serveurs locaux / réseau privé / VPN (403 pour une adresse publique) | Tout serveur |
| SharePoint Online | Refusé (403) ; un fichier SharePoint **synchronisé** reste lisible | Microsoft Graph, compte de l'utilisateur |
| Boutons URL | Ouverture dans le navigateur (action explicite) | Idem |
| Actualisation planifiée | Sources locales / réseau privé ; SharePoint : exécution **sautée** (statut explicite) | Toutes les sources |
| Alertes (webhook) | Adresses locales / réseau privé uniquement ; notifications dans l'application toujours | Toute adresse http(s) |
| Synchronisation GitHub | Refusée (HTTP 403) ; configuration enregistrable | Rapports JSON uniquement (jamais les tables des jeux) ; filtres, sélections et adresses de webhook retirés par défaut |

Le mode se change dans l'en-tête (pastille « Hors ligne / En ligne ») ou dans Réglages ; il est stocké dans `backend/data/settings.json` et pris en compte immédiatement.

## 3 bis. Suite Atelier

Atelier Viz fait partie d'une suite de trois applications locales — **Atelier Viz** (BI), **Atelier Tab** (tableur et base typée), **Atelier Projets** (projets agiles, Git, temps passé) — dont le contrat commun est `docs/SUITE.md` (identique dans les trois dépôts).

| Élément | Dans Atelier Viz |
|---|---|
| Identité visuelle | Copies verbatim du design system d'Atelier Projets (`frontend/src/styles/atelier-ds/` : `light.css`, `dark.css`, `colors.css`). Les jetons d'habillage (`--bg`, `--surface`, `--surface-2`, `--border`, `--fg`, `--muted`, `--grid`, `--canvas`, `--accent`, `--accent-fg`, `--positive`, `--negative`) dérivent des variables de fondation ; accent = violet EPIC (`--type-epic`) rapproché de l'encre, texte des boutons pleins ≥ 4,5:1 (6,2:1 en clair, 6,0:1 en sombre). Rayons 6 / 10 / 16 px, pile de polices système (aucune police téléchargée). **Inchangés** : palette de données (`--series-*`, `--seq-*`, `--div-*`) et thèmes de rapport |
| Thème | `<html class="dark" data-theme="dark">` en sombre, `data-theme="light"` sans classe en clair (Clair / Sombre / Système) |
| Navigation | Sélecteur « Suite Atelier » (icône grille, à gauche du titre) : les trois applications, la courante cochée, état « en marche / arrêtée » des API (`GET /api/health`, `no-cors`, 1,5 s, sans bloquer) ; ouverture par `openExternal`. Adresses dans `lib/suite.ts`, surchargeables par `VITE_ATELIER_VIZ_URL`, `VITE_ATELIER_TAB_URL`, `VITE_ATELIER_PROJETS_URL` |
| Données | Import des enveloppes DataFlow d'Atelier Tab (fichier JSON) ; connecteurs « Atelier Tab » et « Atelier Projets » (§5 sexies) |
| API | `GET /api/health` interrogée par les deux autres applications |

## 4. Modèle d'un rapport (`backend/data/reports/<id>.json`)

```json
{
  "id": "4239a64d7eb5", "version": 1, "name": "Ventes 2026", "dataset_id": "1fc5713fc3f5",
  "pages": [{
    "id": "p1", "name": "Vue d'ensemble", "size": { "width": 1280, "height": 720 },
    "filters": [{ "field": "region", "op": "in", "values": ["Occitanie"] }],
    "visuals": [{
      "id": "v1", "type": "column", "title": null,
      "layout": { "x": 16, "y": 16, "w": 620, "h": 328 },
      "dataset_id": "1fc5713fc3f5",
      "roles": { "category": [{ "field": "date", "bin": "month" }],
                 "series":   [{ "field": "produit" }],
                 "values":   [{ "field": "chiffre_affaires", "agg": "sum" }] },
      "options": { "stacked": true, "compact": true },
      "filters": []
    }]
  }]
}
```
- **Placement libre au pixel près** (comme Power BI) : `size` = taille de la page en px (1 280 × 720 par défaut, préréglages 16:9, 4:3, longue, A4 paysage, ou personnalisée) ; `layout` = position et taille du visuel en px de page. Les visuels peuvent se chevaucher ; l'ordre de la liste est l'ordre d'empilement (le dernier est au premier plan). La page s'allonge d'elle-même quand un visuel dépasse le bas.
- Anciens rapports (sans `size`) : `layout` en cases d'une grille de 24 colonnes ; ils sont convertis en px à l'ouverture (`migratePage`, mêmes positions) puis réenregistrés, et l'export les convertit de la même façon.
- `roles` = puits du volet Visualisations (Axe, Légende, Valeurs…). Une liaison sans `agg` est une dimension ; `bin` regroupe les dates (année, trimestre, mois, semaine, jour).
- `options` est libre côté backend ; chaque type de visuel définit les siennes (registre frontend).
- `bookmarks` : signets du rapport (§ 6 bis). Absent des rapports antérieurs au jalon 6 : lu comme une liste vide, réécrit au prochain enregistrement.

## 5. Catalogue de visuels (22)

| Groupe | Visuels |
|---|---|
| Graphiques | Histogramme, Barres horizontales, Courbes, Aires, Combiné barres + courbes (un seul axe), Secteurs, Anneau, Treemap, Entonnoir, Radar, Cascade, Nuage de points, Jauge, Carte de chaleur |
| Données | Carte KPI (cible + tendance), Table (tri, total, barres de données), Matrice (lignes hiérarchiques, colonne pivot, sous-totaux exacts) |
| Cartes | Choroplèthe (France régions, France départements, monde ; noms ou codes, français ou anglais), Carte à points (latitude / longitude, taille, couleur) |
| Interactivité | Segment (liste, liste déroulante, vignettes, plage de nombres ou de dates), Bouton d'action, Zone de texte |

Options communes : légende, étiquettes, tri (catégorie / valeur), Top N, format des nombres (compact, décimales, préfixe, suffixe), empilé / 100 %, lissage, marqueurs.

**Règles de lisibilité** (guide dataviz) : palette catégorielle validée pour le daltonisme, ordre fixe, 8 séries max puis « Autres » ; 3 couleurs max pour nuages et cartes à points ; rampe séquentielle à une teinte pour intensités ; divergent bleu/rouge pour hausse/baisse ; **jamais de double axe** ; info-bulles partout ; version sombre dédiée.

## 5 bis. Thèmes et mise en forme

**Thème de l'application** : Clair, Sombre ou Système (suit Windows / macOS) — en-tête ou Réglages.

**Thème du rapport** (bouton « Thème » du Studio, enregistré dans `report.theme`) :
- Mode : *Appli* (suit l'application), *Clair* ou *Sombre*.
- Préréglages — clairs : Standard, Verre (visuels transparents), Papier (sans bordure, ombre douce), Contraste élevé ; sombres : Standard, Minuit, Verre.
- Toutes les couleurs en hexadécimal (nuancier + saisie `#2a78d6` / `#28d`) : fond extérieur, fond de page, fond des visuels + opacité (0 % = transparent), bordure (affichage, couleur, épaisseur), arrondi, ombre, texte, texte secondaire, quadrillage, accent, palette de 8 couleurs des données.
- Avertissements de contraste en direct (4,5:1 pour le texte, 3:1 pour les couleurs de données) ; bouton « Palette validée » pour revenir à la palette lisible par les daltoniens.
- Export / import JSON ; import des thèmes Power BI (`dataColors`, `background`, `foreground`, `tableAccent`).

**Style d'un visuel** (onglet Format, enregistré dans `options.style`) : couleur de fond + opacité, bordure (thème / afficher / masquer, couleur, épaisseur), arrondi, ombre, marge intérieure, titre (affichage, couleur, taille, alignement, gras), couleur du texte, palette propre au visuel ; « Appliquer ce style à toute la page ». Un fond choisi adapte automatiquement l'encre, les axes et le quadrillage (visuel sombre dans un rapport clair, et inversement).

Mécanique : variables CSS posées sur la racine du rapport puis sur chaque visuel (`--series-n`, `--fg`, `--grid`, `--visual-bg`…) ; aucun composant de graphique ne contient de couleur en dur. Les palettes des préréglages ont été vérifiées avec le validateur dataviz sur chacun de leurs fonds.

## 5 ter. L'IA qui construit (« Créer avec l'IA »)

Dans le Studio, bouton **Créer avec l'IA** : une phrase (« CA par région sur une carte », « tableau de bord des ventes »…) → 1 à 6 visuels proposés, ajoutés à la page en un clic.

| Étape | Détail |
|---|---|
| Catalogue | Dérivé du registre frontend (types, rôles, options utiles) et envoyé avec la demande : une seule source de vérité |
| Prompt | Règles de choix des graphiques (temps → courbes, géographie → carte, part d'un tout ≤ 6 catégories, pas de double axe…) + schéma du jeu (colonnes, statistiques, 5 lignes) |
| Sortie structurée | Claude CLI : `--json-schema` (`structured_output`) ; Ollama : `format` = schéma JSON ; API Claude : schéma dans la consigne + extraction. Les noms de champs sont une énumération des colonnes réelles |
| Validation / réparation | Types et rôles du catalogue, champs existants, agrégation compatible (sinon `count`), période par défaut `month` sur les dates, maximum par rôle, options filtrées, fond de carte déduit du nom du champ |
| Relance | Si un visuel reste invalide, une seconde demande avec la liste des erreurs ; ce qui ne peut être réparé est écarté (HTTP 422 si rien n'est valide) |
| Studio | Cartes de proposition (type, titre, champs par rôle), « Ajouter » / « Tout ajouter », placement automatique en rangées, une seule entrée d'historique (Ctrl+Z) |
| Confidentialité | Moteur affiché ; hors ligne, Claude n'est pas sélectionnable et « Auto » utilise Ollama. Appels CLI sans télémétrie (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`) |

Mesuré avec Claude (CLI, Sonnet) sur `ventes_2026.csv` : 5 à 6 s par demande ; « CA par région sur une carte » → carte choroplèthe des régions, « évolution mensuelle par produit » → courbes par mois avec légende, « top 3 des produits par marge moyenne » → barres triées, Top N = 3 ; aucune correction nécessaire.

### Résumé de la page (« Résumer »)

Bouton **Résumer** du Studio (édition et lecture) : un titre et 3 à 5 points sur la page affichée, avec ses filtres.

| Étape | Détail |
|---|---|
| Faits | Calculés dans le navigateur à partir des résultats affichés : total, trois premiers et dernier avec leur part, évolution début → fin, maximum / minimum, répartition par légende, KPI et cible, sous-totaux de matrice… Écrits comme à l'écran (« 974 k », « 22 % »). Deux visuels aux faits identiques ne sont envoyés qu'une fois |
| Confidentialité | Seuls ces faits partent vers l'IA (≈ 25 chiffres pour une page de tableau de bord), **jamais les lignes** ; liste consultable (« Voir les chiffres envoyés »). Hors ligne : Ollama uniquement |
| Rédaction | Sortie JSON contrainte (titre, points, numéros des visuels cités). Consigne : recopier les nombres, ne rien calculer, aucune cause ni prévision inventée |
| Vérification | Chaque nombre du texte est relu (formats français, k / M / Md, %, « millions ») et comparé aux faits à la précision écrite près ; dénombrements ≤ 10 et années admis. Un écart → une relance avec la liste ; ce qui reste invérifiable est écarté et signalé |
| Studio | Points reliés à leurs visuels (clic = défilement + sélection), « Insérer dans la page » (zone de texte modifiable en haut, Ctrl+Z), « Copier » |
| Export | Option « Synthèse de chaque page par l'IA » : en tête des notes du présentateur |

Mesuré avec Claude (CLI, Sonnet) : 5 à 8 s par page ; sur les pages de démonstration, aucun chiffre écarté.

## 5 quater. Export PowerPoint

Bouton **PowerPoint** du Studio (édition et lecture) → fichier `.pptx` 16:9 téléchargé. Tout est calculé **dans le navigateur** (pptxgenjs, chargé à la demande) : aucune donnée ne quitte la machine, hors ligne compris.

| Élément | Règle |
|---|---|
| Options | Toutes les pages ou la page affichée ; visuels **Modifiables** (graphiques natifs) ou **Images** (copie fidèle) ; diapositive de titre ; nom de la page en titre ; répartition des pages très longues. Options mémorisées dans le navigateur |
| Mise en page | Positions en px reproduites à l'identique, la largeur de la page occupant celle de la diapositive ; une page ≤ 1,3 diapositive est réduite, au-delà elle est répartie sur plusieurs diapositives en coupant **entre deux rangées** de visuels (« Page (1/2) ») |
| Natifs (modifiables) | Histogramme, barres, courbes, aires (empilé, 100 %), combiné (un seul axe), secteurs, anneau, radar, nuage de points sans légende, bulles → graphiques PowerPoint ; table et matrice → tableaux PowerPoint ; KPI → textes + mini-tendance ; segment → sélection enregistrée ; texte riche ; boutons |
| En image | Ce que PowerPoint ne trace pas nativement : cartes, treemap, entonnoir, cascade, jauge, carte de chaleur, nuage de points par groupe. Rendu hors écran du composant à sa taille réelle, PNG ×2 |
| Données | Mêmes requêtes et filtres qu'à l'écran (filtres de page, segments, sélection de la page affichée), couleurs stables par valeur, « Autres » au-delà de 8 séries |
| Thème | Couleurs du thème du rapport et des styles de visuels résolues en hexadécimal (fond de page, cadres, bordures, transparence, arrondis, ombre, palette, encre) |
| Nombres | Codes de format Excel : décimales comme à l'écran, notation compacte (axe : une unité commune avec marge ; étiquettes : « 974 k », « 1,9 M »), préfixe / suffixe, 100 % ; séparateurs selon la langue de PowerPoint |
| Tables | Colonnes dimensionnées pour ne jamais passer à la ligne ; lignes au-delà de la hauteur du visuel résumées (« … et 24 autres lignes ») ; matrice repliée = premier niveau, 12 colonnes de valeurs au plus + Total |
| Boutons | « Ouvrir une URL » (gabarit résolu avec les filtres) et « Aller à une page » restent cliquables en diaporama ; webhooks non liés |
| Structure | Disposition « page » avec titre et numéro, une section par page, notes du présentateur : filtres de page, segments, sélection, source, date, remarques |

Vérifié : fichiers validés (schéma OOXML, graphiques, relations), rendus contrôlés en clair et en sombre ; galerie de 24 visuels exportée en 4 s (modifiable) et 8 s (images).

## 5 quinquies. Modélisation : mesures, colonnes calculées, exploration

**Mesures et colonnes calculées** (volet Données → « + Mesure » / « + Colonne ») :

| | Colonne calculée | Mesure calculée |
|---|---|---|
| Évaluée | Ligne par ligne | Sur chaque groupe (barre, ligne, sous-total), jamais additionnée |
| Exemple | `prix_unitaire * 1.2` · `IF(chiffre_affaires >= 5000, "Grosse vente", "Standard")` | `SUM(chiffre_affaires * taux_marge / 100)` · `DIVIDE([Marge], SUM(chiffre_affaires))` |
| Utilisation | Comme une colonne : axe, légende, filtre, segment, table | Puits de valeurs (`agg: "calc"`, clé `calc(nom)`) |
| Stockage | Vue DuckDB `v_<id>` = table + colonnes calculées ; profil (types, statistiques) recalculé | Modèle du jeu (`profile.model`), compilée à chaque requête |

- **Langage** : `+ - * /`, comparaisons, `AND/OR/NOT` (ou `ET/OU/NON`), textes entre guillemets, noms entre crochets s'ils contiennent des espaces. Fonctions en anglais ou en français : `SUM/SOMME`, `AVG/MOYENNE`, `COUNT/NB` (`COUNT(*)`, `COUNT(DISTINCT x)`), `COUNT_DISTINCT`, `MIN`, `MAX`, `MEDIAN`, `DIVIDE/DIVISER`, `IF/SI`, `ROUND/ARRONDI`, `ABS`, `COALESCE`, `YEAR/ANNEE`, `MONTH/MOIS`, `CONCAT`.
- **Sécurité** : aucune expression n'est passée à DuckDB ; elle est analysée (lexer + parseur), typée et recompilée (`quote_ident` pour les noms, littéraux réécrits). Division par zéro = vide. Bornes : 2 000 caractères, 300 éléments, 40 niveaux d'imbrication ; noms sans caractère de contrôle ni invisible ; toute erreur du moteur devient un 422 lisible (jamais un 500). Revue de sécurité indépendante faite : aucune injection possible, 4 défauts de robustesse corrigés et couverts par des tests.
- **Contrôles** : type (« SUM attend un nombre, pas un texte »), agrégation obligatoire dans une mesure, références circulaires, noms en double, suggestions (« Vouliez-vous dire chiffre_affaires ? »), position de l'erreur soulignée. Un modèle invalide n'est jamais enregistré (HTTP 422 avec la liste des erreurs).
- **Éditeur** : vérification à la frappe, aperçu (5 premières valeurs ou valeur sur tout le jeu), fonctions et champs insérables, renommage répercuté dans les visuels du rapport, suppression avec avertissement si l'élément est utilisé.

**Exploration (drill-down)** : plusieurs champs dans l'Axe d'un histogramme, de barres, courbes, aires, combiné, secteurs, anneau, treemap, entonnoir ou cascade forment une hiérarchie (4 niveaux au plus).
- Barre d'exploration du visuel : ↑ monter, ↓ mode exploration (un clic sur une barre ou une part descend dans cet élément au lieu de filtrer), ⇊ niveau suivant pour tous les éléments ; fil d'Ariane (« Occitanie › produit », « region (tout) › produit »).
- « Hiérarchie de dates » : un champ date devient année › trimestre › mois.
- État enregistré dans `options.drill` ; requêtes, export PowerPoint et résumé IA utilisent le niveau affiché (`drillView`).

## 5 sexies. Connecteurs de données

« Se connecter à une source » (page Données) : connexions enregistrées, parcours, aperçu, import, actualisation.

| Source | Pilote | Lecture |
|---|---|---|
| SQL Server / Azure SQL | pymssql (FreeTDS) | Tables et vues (`INFORMATION_SCHEMA`), requête libre ; `TOP (n)` ; instance nommée, compte Windows, TLS |
| PostgreSQL | psycopg 3 | Session `default_transaction_read_only` + `statement_timeout` |
| MySQL / MariaDB | PyMySQL | `SET SESSION TRANSACTION READ ONLY` |
| SQLite | sqlite3 | Fichier ouvert en `mode=ro` |
| Fichier synchronisé | — | CSV / XLSX (feuille au choix) / JSON d'un dossier OneDrive, SharePoint, Teams ou réseau |
| SharePoint Online | httpx → Microsoft Graph | Fichier par lien (`/shares/u!…/driveItem`) ou liste (colonnes visibles, pagination) ; connexion par code d'appareil |
| Atelier Tab | — (fichiers) | Tables publiées par l'application de bureau dans un dossier (défaut `~/Atelier_Tab/exports`, `ATELIER_TAB_EXPORTS_DIR`) : instantanés DataFlow v2.1.0 `<tableId>.json`. Liste (table, projet, date, lignes), aperçu, import, actualisation. Aucun réseau |
| Atelier Projets | httpx → API locale | `GET /api/exports/datasets` (jeux : éléments de travail, temps passé, jalons), `GET /api/exports/datasets/:name?projectId=` ; projet facultatif (`GET /api/projects`). Adresse par défaut `http://127.0.0.1:3000` (`ATELIER_PROJETS_URL`), soumise à `check_server` (hors ligne : machine et réseau privé). Aucun secret, sans proxy système |

- **Registre** : `data/connections.json` (sans secret) ; secrets dans le trousseau système (`keyring`), sinon `data/secrets.json` en 0600. L'API ne renvoie que `has_password` / `signed_in`.
- **Requêtes libres** : une instruction `SELECT` / `WITH`, mots-clés d'écriture refusés hors chaînes et commentaires (`INSERT`, `INTO`, CTE `DELETE`, `OPENROWSET`…). Garde-fou complété par la lecture seule côté serveur.
- **Types** : ceux de la base sont gardés (pas de réinterprétation : un code postal `VARCHAR` reste du texte) ; `DECIMAL` → nombre, dates avec fuseau → UTC.
- **Import** : copie dans DuckDB (`ds_<id>`) avec `origin` (connexion, table / requête / lien, limite de lignes, date). Limite par défaut 2 000 000 lignes (`CONNECTOR_MAX_ROWS`).
- **Actualisation** (`POST /api/datasets/{id}/refresh`) : même identifiant ; le modèle est revalidé sur les nouvelles colonnes (409 et rien ne change s'il ne tient plus) ; les visuels ouverts se rechargent.
- **Instantanés DataFlow** (Atelier Tab, et tout fichier JSON importé qui est une enveloppe : `target_system` + `schema_version` + `project.columns_schema`) : colonnes `_ligne` (`row_index`) et `_id` (`record_id`), puis une par entrée de `columns_schema` (nom = `label`) ; valeur = `computed`, codes d'erreur `#…!` → vide ; types d'après `type` (`currency`, `number`, `percent` → nombre ; `formula` → nombre si toutes ses valeurs le sont ; `date` → date ; `checkbox` → booléen ; sinon texte, sans réinterprétation). Les lignes de total (`summary_rows`) ne sont pas importées (`app/services/data/dataflow.py`).
- **Atelier Projets** : types de colonnes respectés (`string`, `number`, `date`, `datetime` → UTC sans fuseau, `boolean`), colonnes nommées par leur libellé ; un import mémorise le jeu et le projet dans `origin`. Projets arrêté → 503 « Atelier Projets est injoignable… lancez-le » ; ancienne version sans exports → 404 explicite.
- **Essais** : SQLite et Graph simulé dans `test_connections.py` ; Atelier Tab (dossier temporaire) et Atelier Projets (`httpx.MockTransport`) dans `test_connections_atelier.py`, enveloppes DataFlow dans `test_dataflow.py` ; vrais PostgreSQL / MySQL dans `test_connections_live.py` (variables `ATELIER_TEST_PG`, `ATELIER_TEST_MYSQL`).

## 6. Interactions

- **Filtres** (dans l'ordre d'application) : page → segments de la page → sélection par clic dans un autre visuel (filtrage croisé) → filtres du visuel. Ils ne s'appliquent qu'aux visuels du même jeu de données (ou possédant le champ, pour les filtres de page).
- **Filtrage croisé** : clic sur une barre, une part, une case de treemap, une région ou une ligne de table ; nouveau clic ou Échap pour annuler.
- **Édition** : glisser un champ sur un visuel ou dans un puits ; clic sur un champ = ajout au visuel sélectionné, ou création d'un visuel adapté ; clic sur une icône = ajout, ou changement de type en conservant les champs.
- **Placement** : déplacement par la poignée du haut du visuel, redimensionnement par 8 poignées (Maj : proportions conservées), repères d'alignement roses sur les bords et centres des autres visuels, les marges et le centre de la page (Alt : sans accroche), cote x/y ou L × H pendant le geste ; flèches du clavier pour 1 px (Maj : 10 px, un seul retour arrière pour une suite d'ajustements) ; X / Y / L / H au pixel près dans l'onglet Format ; premier plan / arrière-plan ; une copie (Ctrl+D) est décalée de 16 px. Un nouveau visuel prend le premier espace libre de la page.
- **Zoom** : ajusté à la largeur par défaut, paliers de 25 % à 200 %, Ctrl + molette ; la page est mise à l'échelle d'un bloc (textes compris), info-bulles exactes à tout zoom.
- **Raccourcis** : Ctrl+Z / Ctrl+Y (annuler / rétablir, 60 niveaux), Ctrl+D (dupliquer), Suppr (supprimer), flèches (ajuster), Échap.
- **Modes** : Édition (volets, déplacement, redimensionnement) et Lecture.
- **Sauvegarde** automatique 0,8 s après la dernière modification.
- **Rapport de démarrage** : mise en page générée depuis le profil d'un jeu (KPI, évolution, répartition, carte si un champ région/département/pays est reconnu, segment, matrice, table, boutons).

### Boutons d'automatisation
| Action | Détail |
|---|---|
| Ouvrir une URL | Gabarit avec variables `{champ}` (valeurs filtrées), `{page}`, `{rapport}`, `{date}` ; http, https, mailto uniquement |
| Appeler un webhook | GET ou POST via le backend ; corps : `{rapport, page, filtres, declenche_le}` ; confirmation optionnelle ; hors ligne = adresses locales seulement |
| Aller à une page | Navigation entre pages du rapport |
| Réinitialiser les filtres | Segments, filtres de page, sélection |

## 6 bis. Partage et automatisation (jalon 6)

### Signets
Comme dans Power BI : bouton **Signets** du Studio (édition et lecture) → volet Signets.

| Élément | Règle |
|---|---|
| Capture | Page affichée ; pour **chaque page** : filtres de page, sélection des segments (valeurs ou plage), niveau d'exploration des visuels explorables ; filtrage croisé en cours (s'il porte sur la page affichée) |
| Stockage | `report.bookmarks` (JSON du rapport) : `id`, `name`, `page_id`, `apply_page`, `apply_data`, `pages{page → {filters, visuals{visuel → {selected, range, drill}}}}`, `selection`, dates. 100 signets au plus |
| Appliquer | Clic sur le signet ; pas d'entrée d'historique (comme un segment). Options « Page affichée » / « Données » (on peut ne rétablir que la page, ou que les filtres) |
| Robustesse | Pages ou visuels supprimés depuis la capture : ignorés, signalés (« 2 éléments ignorés ») ; visuels ajoutés depuis : laissés tels quels |
| Gestion | Ajouter (nom proposé « Signet N »), renommer (double-clic), mettre à jour avec l'état actuel, monter / descendre, supprimer avec confirmation |
| Bouton | Action « Appliquer un signet » du Bouton d'action (non liée dans l'export PowerPoint, comme les webhooks) |

Logique pure : `studio/bookmarks.ts` (`captureBookmark`, `applyBookmarkTo`), testée dans `bookmarks.test.ts`.

### Actualisation planifiée des sources
Pour tout jeu importé depuis une connexion (`origin`) : page **Données → Planifier**, ou écran **Automatisation**.

| Élément | Règle |
|---|---|
| Planification | Désactivée · toutes les N minutes / heures (une semaine au plus) · chaque jour à HH:MM (heure locale de la machine, changements d'heure compris) |
| Ordonnanceur | Tâche asyncio du lifespan (`RefreshScheduler.run_forever`, passage toutes les `SCHEDULER_PERIOD_SECONDS` = 15 s) ; horloge injectable (`tick` testé sans attente) ; échéance manquée pendant que l'application était fermée : rattrapée **une fois** ; les tâches lancées sont retenues (référence forte) |
| Arrêt | Lifespan : boucle annulée, puis `RefreshScheduler.shutdown` **avant** la fermeture de DuckDB : plus aucun lancement, tâches annulées, actualisations en cours (dans un fil, manuelles comprises) attendues au plus `SCHEDULER_SHUTDOWN_SECONDS` (10 s) ; non terminée à temps → journalisée **interrompue** |
| Exclusion | Une seule exécution à la fois par jeu (verrou asyncio) : une exécution planifiée concurrente est sautée, une actualisation manuelle reçoit un 409 |
| Politique réseau | SharePoint Online hors ligne : exécution **sautée** (« exige le mode En ligne ») ; serveur SQL public hors ligne : sautée (403 de `check_server`) |
| Journal | 20 dernières exécutions par jeu : début, durée, statut (réussie / échec / sautée / interrompue), déclenchement (planifiée / manuelle), lignes, message (modèle incompatible, source introuvable…). L'actualisation manuelle passe aussi par le journal |
| Persistance | `data/schedules.json` (à côté de `connections.json`, écriture atomique, sans secret) ; planification oubliée avec son jeu |
| Rechargement | Le front interroge `GET /api/refresh/versions` (horodatage `origin.refreshed_at` par jeu) toutes les 20 s quand la fenêtre est visible ; une version changée → profil relu + `invalidateQueries` : les visuels ouverts se rechargent |
| Après succès | Observateurs prévenus (`on_refreshed`) : les alertes du jeu sont évaluées |

### Alertes sur seuil
Écran **Automatisation → Alertes**, ou icône cloche d'un visuel **KPI / jauge** du Studio (mesure, filtres actifs et cible repris).

| Élément | Règle |
|---|---|
| Définition | Jeu + mesure (`Measure` du langage de requête : agrégat d'un champ, nombre de lignes, ou mesure calculée `agg = "calc"`) + filtres facultatifs (`Filter`) + comparaison (>, ≥, <, ≤, =, ≠) + seuil + actions |
| Calcul | `run_query` du moteur : champs validés contre le profil, mesures calculées compilées par `expressions.py`, valeurs en paramètres liés — **jamais de SQL brut**. Mesure vérifiée à l'enregistrement (422 sinon) ; valeur actuelle affichée pendant la saisie |
| Évaluation | Après chaque actualisation réussie du jeu, à la création, et à la demande (« Évaluer maintenant ») |
| Anti-rebond | Déclenche au **franchissement** (condition qui devient vraie), pas à chaque évaluation où elle reste vraie ; règle modifiée = état remis à zéro ; valeur vide ou erreur : état inchangé |
| Concurrence | Verrou **par alerte** (les autres alertes s'évaluent en parallèle) ; état et notification enregistrés avant le webhook, appelé **hors verrou** (résultat rattaché ensuite à l'événement) ; règle modifiée pendant l'évaluation (empreinte `rule_fingerprint` différente) → résultat ignoré (« Règle modifiée pendant l'évaluation »), sans action ni changement d'état |
| Actions | Notification dans l'application (cloche de l'en-tête, non lues, « Tout marquer comme lu ») et / ou webhook GET / POST via `services/actions.py` (corps : alerte, jeu, valeur, comparaison, seuil, message, date) ; hors ligne : adresses locales seulement |
| Historique | 50 évaluations par alerte (valeur, condition, déclenchement, statut HTTP ou erreur du webhook) ; 100 notifications ; `data/alerts.json` ; alertes supprimées avec leur jeu |

### Synchronisation des rapports avec GitHub
**Réglages → Synchronisation GitHub**. Mode « En ligne » obligatoire (403 sinon).

| Élément | Règle |
|---|---|
| Configuration | Dépôt `propriétaire/dépôt`, branche (créée au premier envoi depuis la branche par défaut si absente), dossier (`atelier-viz/rapports` par défaut ; pas de `..` ni `.git`) ; `data/github.json` sans secret |
| Jeton | Jeton « fine-grained » (Contents : lecture / écriture), rangé au trousseau (`github:token`), repli `GITHUB_TOKEN` ; jamais renvoyé (`has_token`), jamais dans un message d'erreur |
| Ce qui part | **Rapports uniquement** : un fichier `<id>.json` par rapport (pages, visuels, champs utilisés, titres, textes, thème, signets). Jamais les tables des jeux, la base DuckDB, les connexions, les planifications, les alertes ni les secrets du trousseau. Un rapport **recopie** pourtant des valeurs des données et peut porter un secret : voir « Nettoyage » — le texte de l'interface dit exactement ce qui part selon l'option |
| Nettoyage | Option « Retirer les sélections, filtres et adresses de webhook avant l'envoi » (`strip_private`, **activée par défaut**, `services/report_privacy.py`) : retire les valeurs des filtres de page et de visuel, `options.selected` / `range` / `drill`, l'état des signets (filtres, sélections, exploration, filtrage croisé) et `options.url` des boutons « Appeler un webhook » (les liens « Ouvrir une URL » restent). Les empreintes de synchronisation portent sur la forme envoyée. **Récupération = fusion explicite** : pour chaque page, visuel ou signet qui existe déjà sur le poste, ces champs restent ceux du poste (jamais effacés par une version nettoyée) ; un élément nouveau est importé tel quel. Option désactivée : tout part tel quel, et la récupération remplace tout |
| Visibilité | « Tester la connexion » lit `private` du dépôt (`GitHubTest.private`, mémorisé dans `repo_private`) ; dépôt public → avertissement en rouge dans les réglages (plus fort si le nettoyage est désactivé) |
| Envoyer | Un **seul commit par envoi** (API Git Data : arbre sur l'arbre de tête → commit → mise à jour de la branche **sans forcer**) ; message clair (« Atelier Viz : 2 rapport(s) mis à jour » + noms) ou personnalisé ; rien à envoyer = aucun commit ; branche modifiée pendant l'envoi → 409, rien d'écrasé |
| Récupérer | Rapports du dossier importés (nouveaux) ou mis à jour (modifiés seulement sur GitHub) ; fichiers illisibles ignorés et listés |
| Conflits | Base : sha de blob Git distant et local de chaque rapport à la dernière synchronisation (`blob_sha`, comparé au `sha` de l'API sans télécharger). Modifié des deux côtés → conflit listé, **rien n'est écrasé** sans choix explicite : garder ce poste, prendre GitHub, importer une copie (« … (copie GitHub) ») ; à l'envoi, « Écraser GitHub avec ce poste » |
| État | Par rapport, sans réseau : jamais envoyé / modifié / à jour ; derniers envoi (lien du commit) et récupération |

## 7. API backend

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/health` | État |
| GET / PUT | `/api/settings` | Mode en ligne (`online_mode`) |
| GET | `/api/ai/providers` | État d'Ollama et de Claude (désactivé hors ligne) |
| POST | `/api/ai/chat` | Assistant ; `dataset_id` optionnel joint le schéma |
| POST | `/api/ai/visuals` | Phrase + catalogue → visuels validés (`BuildResponse` : visuels, explication, moteur, corrections) |
| POST | `/api/ai/summary` | Faits d'une page → synthèse vérifiée (`SummaryResponse` : titre, points reliés aux visuels, moteur, éléments écartés) |
| POST | `/api/datasets` | Import multipart (CSV/XLSX/JSON, 50 Mo) → profil ; persisté dans DuckDB |
| GET | `/api/datasets` · `/api/datasets/{id}` · `/api/datasets/{id}/rows` | Liste, profil, lignes paginées |
| DELETE | `/api/datasets/{id}` | Suppression (table et vue) |
| PUT | `/api/datasets/{id}/model` | Colonnes et mesures calculées : validation complète, vue recréée, profil mis à jour (422 + liste d'erreurs sinon) |
| POST | `/api/datasets/{id}/model/check` | Vérification d'une expression pendant la saisie : erreur localisée, type, aperçu |
| GET · POST | `/api/samples` | Jeux d'exemple du dossier `samples/` : liste (déjà importés ou non) · import des absents, sans doublon |
| POST | `/api/query` | Dimensions, mesures (sum, avg, median, min, max, count, count_distinct), filtres (in, not_in, eq, neq, gt, gte, lt, lte, between, contains, is_null, not_null, avec période), tri, limite, `grouping_sets` |
| GET / POST | `/api/reports` | Liste, création |
| GET / PUT / DELETE | `/api/reports/{id}` | Lecture, sauvegarde, suppression |
| POST | `/api/actions/webhook` | Appel d'un webhook depuis un bouton |
| GET | `/api/connections/connectors` | Types de sources et état des pilotes (Atelier Tab / Projets : emplacement par défaut) |
| GET / POST | `/api/connections` | Connexions enregistrées (sans secret) · création |
| PUT / DELETE | `/api/connections/{id}` | Modification (`password` absent = inchangé) · suppression avec ses secrets |
| POST | `/api/connections/test` · `/api/connections/{id}/test` | Essai avant / après enregistrement |
| GET | `/api/connections/{id}/tables` | Tables et vues, feuilles Excel (`?url=` pour SharePoint), tables publiées par Atelier Tab, jeux et projets d'Atelier Projets |
| POST | `/api/connections/{id}/preview` · `/import` | Aperçu (≤ 200 lignes) · import en jeu de données actualisable |
| POST | `/api/connections/{id}/login` · `/login/poll` · `/logout` | SharePoint : connexion Microsoft par code d'appareil |
| POST | `/api/datasets/{id}/refresh` | Relit la source d'un jeu importé depuis une connexion (inscrit au journal ; 409 si déjà en cours) |
| GET | `/api/refresh` · `/api/refresh/versions` | Jeux actualisables (planification, prochaine exécution, journal) · horodatage de version par jeu |
| GET / PUT | `/api/refresh/{id}` | Planification d'un jeu (`off`, `interval` + `every` / `unit`, `daily` + `at`) |
| POST | `/api/refresh/{id}/run` | Actualise tout de suite ; renvoie l'exécution (réussie / échec / sautée) |
| GET / POST | `/api/alerts` | Alertes (`?dataset_id=`) · création (mesure vérifiée, première évaluation) |
| GET / PUT / DELETE | `/api/alerts/{id}` | Lecture, modification (anti-rebond remis à zéro si la règle change), suppression |
| POST | `/api/alerts/{id}/evaluate` | Évaluation à la demande |
| GET · POST | `/api/alerts/notifications` · `/read` | Notifications dans l'application · marquer comme lues (liste vide = toutes) |
| GET / PUT / DELETE | `/api/github` | État (sans jeton, sans réseau) · configuration (`token` absent = inchangé, vide = effacé) · oubli |
| POST | `/api/github/test` · `/push` · `/pull` | Vérifie l'accès · envoie (un commit) · récupère (résolutions des conflits) — en ligne uniquement |

Sécurité du moteur : aucun SQL ne vient du client ; champs validés contre le schéma, identifiants entre guillemets, valeurs en paramètres liés (test d'injection inclus).

## 8. Exigences non fonctionnelles
- Fonctionne sans Internet (aucune ressource externe au chargement).
- Secrets uniquement côté backend (`.env`).
- Tests : pytest (239, + 2 sur serveurs réels) côté back, Vitest (146) côté front ; parcours vérifiés dans un vrai navigateur (Playwright) ; fichiers PowerPoint validés et rendus.
- Accessibilité : noms accessibles des visuels = titre affiché, navigation clavier dans les volets, couleurs jamais seules porteuses de sens (légendes, libellés).
- Performance : 10 000 lignes importées et profilées en 0,17 s ; agrégations DuckDB.

## 9. Roadmap
- **Jalon 0 — Socle** ✅ · **0b — Claude via la CLI** ✅ · **1 — Import et profilage** ✅
- **Jalon 2 — Studio** ✅ : DuckDB, rapports multi-pages, 22 visuels, segments, filtres, filtrage croisé, cartes hors ligne, boutons d'automatisation, mode hors ligne / en ligne.
- **Jalon 2 bis — Thèmes** ✅ : thème de l'application (clair / sombre / système), thèmes de rapport, styles par visuel, couleurs hexadécimales, import de thèmes Power BI.
- **Jalon 3 — IA qui construit** ✅ : « Crée un graphique du CA par région » → visuels validés ajoutés au Studio (Claude via `claude -p --json-schema`, Ollama en format JSON). Résumé de page vérifié chiffre par chiffre, insérable dans le rapport et dans les notes PowerPoint.
- **Jalon 4 — Export PowerPoint** ✅ : diapositives 16:9, graphiques et tableaux natifs modifiables, images pour les visuels sans équivalent, thème du rapport, notes avec les filtres. Reste : export PDF et image d'une page.
- **Jalon 5 — Modélisation** ✅ : mesures et colonnes calculées (langage analysé et compilé, jamais de SQL brut), hiérarchies et exploration (drill-down), hiérarchie de dates. Reste : relations entre tables (jointures entre jeux de données).
- **Jalon 5 bis — Placement libre** ✅ : visuels au pixel près n'importe où sur la page (taille de page en px, repères d'alignement, poignées, clavier, saisie X/Y/L/H, superposition et ordre, zoom), conversion automatique des anciens rapports.
- **Jalon 5 ter — Connecteurs** ✅ : SQL Server, PostgreSQL, MySQL / MariaDB, SQLite, fichiers OneDrive / SharePoint synchronisés, SharePoint Online (fichiers et listes), en lecture seule, secrets au trousseau, actualisation. Reste : actualisation planifiée, Excel / CSV sur un serveur HTTP, Snowflake / BigQuery.
- **Jalon 5 quater — Application Mac** ✅ : « Atelier Viz.app » à double-cliquer (fenêtre native, icône, Dock), interface servie par l'API, enregistrement natif des fichiers.
- **Jalon 5 quinquies — Suite Atelier** ✅ : design system commun (copies verbatim, jetons dérivés, accent violet), thème `data-theme` + `dark`, sélecteur « Suite Atelier » avec état des API, import des enveloppes DataFlow, connecteurs Atelier Tab (instantanés) et Atelier Projets (API locale), actualisables (`docs/SUITE.md`).
- **Jalon 6 — Partage et automatisation** ✅ : signets (volet, bouton d'action), actualisation planifiée des sources (ordonnanceur, journal, rechargement des visuels), alertes sur seuil (anti-rebond, notifications, webhook), synchronisation des rapports avec un dépôt GitHub (un commit par envoi, conflits jamais écrasés). Reste : signets personnels / groupes de signets et diaporama de signets ; notifications système (macOS) et e-mail ; alertes par dimension (« pour chaque région ») et sur variation (%) ; historique Git d'un rapport et restauration d'une version ; GitHub Enterprise (URL d'API configurable) ; actualisation planifiée quand l'application est fermée (service système).
