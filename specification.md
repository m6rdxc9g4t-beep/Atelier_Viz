# Spécifications fonctionnelles et techniques — Atelier Viz

## 1. Vision
Un **outil de BI local, dans l'esprit de Power BI**, qui va plus loin sur l'automatisation :
- tout fonctionne **hors ligne** par défaut : données, calculs, rapports et fonds de carte restent sur la machine ;
- un interrupteur **« En ligne »** active Claude (via la CLI Claude Code et l'abonnement claude.ai) et les webhooks vers Internet ;
- des rapports multi-pages avec plus de 20 types de visuels, segments, filtres, filtrage croisé, cartes ;
- des **boutons d'automatisation** (URL paramétrées par les filtres, webhooks n8n / Make / Zapier, navigation) ;
- **export PowerPoint** : une page = une diapositive, graphiques et tableaux PowerPoint modifiables, généré sur la machine.

## 2. Architecture

```
┌────────────────────────────────────────┐   /api (JSON)   ┌──────────────────────────────────────────┐
│ Frontend React 19 + TS (Vite)          │ ──────────────▶ │ Backend FastAPI                           │
│ Studio : canvas (react-grid-layout),   │                 │  routes → services                        │
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
| Frontend | React 19, TypeScript strict, Vite, Tailwind v4, Recharts 3, d3-geo, react-grid-layout 2, zustand | Studio, visuels, cartes |
| Backend | FastAPI, Pydantic v2 | API, validation |
| Moteur | **DuckDB** (fichier local) | Stockage des jeux importés, agrégations SQL générées, GROUPING SETS |
| Import | pandas + openpyxl | CSV FR/EN, XLSX, JSON → typage → table DuckDB |
| Rapports | Fichiers JSON (`backend/data/reports/`) | Versionnables tels quels dans Git |
| IA locale | Ollama | Mode hors ligne |
| IA en ligne | Claude via `claude -p` (abonnement) ou API | Mode en ligne uniquement |

## 3. Principe hors ligne / en ligne

| | Hors ligne (défaut) | En ligne |
|---|---|---|
| Données, calculs, rapports | Locaux | Locaux |
| Fonds de carte | Empaquetés (France régions/départements, monde) | Idem |
| Polices | Empaquetées | Idem |
| IA | Ollama uniquement ; Claude refusé (HTTP 403) | Ollama + Claude |
| Ce qui part vers l'IA | — | Schéma + 5 lignes, seulement si « Joindre le schéma » est coché |
| Boutons webhook | Adresses locales / réseau privé uniquement | Toute adresse http(s) |
| Boutons URL | Ouverture dans le navigateur (action explicite) | Idem |

Le mode se change dans l'en-tête (pastille « Hors ligne / En ligne ») ou dans Réglages ; il est stocké dans `backend/data/settings.json` et pris en compte immédiatement.

## 4. Modèle d'un rapport (`backend/data/reports/<id>.json`)

```json
{
  "id": "4239a64d7eb5", "version": 1, "name": "Ventes 2026", "dataset_id": "1fc5713fc3f5",
  "pages": [{
    "id": "p1", "name": "Vue d'ensemble",
    "filters": [{ "field": "region", "op": "in", "values": ["Occitanie"] }],
    "visuals": [{
      "id": "v1", "type": "column", "title": null,
      "layout": { "x": 0, "y": 0, "w": 12, "h": 14 },
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
- Grille de **24 colonnes**, lignes de 16 px.
- `roles` = puits du volet Visualisations (Axe, Légende, Valeurs…). Une liaison sans `agg` est une dimension ; `bin` regroupe les dates (année, trimestre, mois, semaine, jour).
- `options` est libre côté backend ; chaque type de visuel définit les siennes (registre frontend).

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
| Mise en page | Positions de la grille reproduites à l'identique (page de référence de 1 280 px) ; une page ≤ 1,3 diapositive est réduite, au-delà elle est répartie sur plusieurs diapositives en coupant **entre deux rangées** de visuels (« Page (1/2) ») |
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

## 6. Interactions

- **Filtres** (dans l'ordre d'application) : page → segments de la page → sélection par clic dans un autre visuel (filtrage croisé) → filtres du visuel. Ils ne s'appliquent qu'aux visuels du même jeu de données (ou possédant le champ, pour les filtres de page).
- **Filtrage croisé** : clic sur une barre, une part, une case de treemap, une région ou une ligne de table ; nouveau clic ou Échap pour annuler.
- **Édition** : glisser un champ sur un visuel ou dans un puits ; clic sur un champ = ajout au visuel sélectionné, ou création d'un visuel adapté ; clic sur une icône = ajout, ou changement de type en conservant les champs.
- **Raccourcis** : Ctrl+Z / Ctrl+Y (annuler / rétablir, 60 niveaux), Ctrl+D (dupliquer), Suppr (supprimer), Échap.
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
| POST | `/api/query` | Dimensions, mesures (sum, avg, median, min, max, count, count_distinct), filtres (in, not_in, eq, neq, gt, gte, lt, lte, between, contains, is_null, not_null, avec période), tri, limite, `grouping_sets` |
| GET / POST | `/api/reports` | Liste, création |
| GET / PUT / DELETE | `/api/reports/{id}` | Lecture, sauvegarde, suppression |
| POST | `/api/actions/webhook` | Appel d'un webhook depuis un bouton |

Sécurité du moteur : aucun SQL ne vient du client ; champs validés contre le schéma, identifiants entre guillemets, valeurs en paramètres liés (test d'injection inclus).

## 8. Exigences non fonctionnelles
- Fonctionne sans Internet (aucune ressource externe au chargement).
- Secrets uniquement côté backend (`.env`).
- Tests : pytest (130) côté back, Vitest (84) côté front ; parcours vérifiés dans un vrai navigateur (Playwright) ; fichiers PowerPoint validés et rendus.
- Accessibilité : noms accessibles des visuels = titre affiché, navigation clavier dans les volets, couleurs jamais seules porteuses de sens (légendes, libellés).
- Performance : 10 000 lignes importées et profilées en 0,17 s ; agrégations DuckDB.

## 9. Roadmap
- **Jalon 0 — Socle** ✅ · **0b — Claude via la CLI** ✅ · **1 — Import et profilage** ✅
- **Jalon 2 — Studio** ✅ : DuckDB, rapports multi-pages, 22 visuels, segments, filtres, filtrage croisé, cartes hors ligne, boutons d'automatisation, mode hors ligne / en ligne.
- **Jalon 2 bis — Thèmes** ✅ : thème de l'application (clair / sombre / système), thèmes de rapport, styles par visuel, couleurs hexadécimales, import de thèmes Power BI.
- **Jalon 3 — IA qui construit** ✅ : « Crée un graphique du CA par région » → visuels validés ajoutés au Studio (Claude via `claude -p --json-schema`, Ollama en format JSON). Résumé de page vérifié chiffre par chiffre, insérable dans le rapport et dans les notes PowerPoint.
- **Jalon 4 — Export PowerPoint** ✅ : diapositives 16:9, graphiques et tableaux natifs modifiables, images pour les visuels sans équivalent, thème du rapport, notes avec les filtres. Reste : export PDF et image d'une page.
- **Jalon 5 — Modélisation** ✅ : mesures et colonnes calculées (langage analysé et compilé, jamais de SQL brut), hiérarchies et exploration (drill-down), hiérarchie de dates. Reste : relations entre tables (jointures entre jeux de données).
- **Jalon 6 — Partage et automatisation** : signets, actualisation planifiée des sources, alertes sur seuil (webhook), synchronisation des rapports avec un dépôt GitHub.
