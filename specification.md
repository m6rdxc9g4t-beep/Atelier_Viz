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

- `scripts/macos/build_app.sh` crée `~/Applications/Atelier Viz.app` (Info.plist, icône `scripts/macos/icon.png` → icns, lanceur qui fige le chemin du dépôt, l'interpréteur Python et le PATH). C'est le seul moment où les dépendances npm sont installées.
- Au lancement, **jamais de `npm install`** (réseau, scripts de paquets) : `app/launcher.py` décide — interface à jour (`ok`) ; sources plus récentes et `node_modules` conforme à `package-lock.json` (comparé à `node_modules/.package-lock.json`, paquets facultatifs absents tolérés) → `npm run build` seulement ; dépendances absentes ou modifiées → message invitant à relancer `build_app.sh`, l'ancienne interface reste utilisée.
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

Le mode se change dans l'en-tête (pastille « Hors ligne / En ligne ») ou dans Réglages ; il est stocké dans `backend/data/settings.json` (fusion et écriture sous un même verrou, écriture atomique) et pris en compte immédiatement.

**API locale seulement** (docs/SUITE.md §5.1, `app/core/local_only.py`) : un garde ASGI, exécuté avant CORS, refuse (403, message en français) toute requête dont l'en-tête `Host` n'est pas de bouclage (`127.0.0.1`, `localhost`, `[::1]`, port quelconque) ou listé dans `ALLOWED_HOSTS` (virgules) — protection contre le DNS rebinding : un site qui pointerait vers 127.0.0.1 ne peut ni lire l'API, ni passer Viz en ligne, ni appeler Claude. Pour les écritures (POST, PUT, PATCH, DELETE), `Origin` doit être absente (curl, scripts) ou locale ; l'origine `null` est refusée. Le proxy Vite (`changeOrigin: false`) et la fenêtre de l'application (`http://127.0.0.1:8000`) passent tels quels. `fastapi>=0.132` : un corps JSON sans `Content-Type` JSON est refusé (pas de formulaire « simple » d'un autre site).

### Choix du moteur d'IA (docs/SUITE.md §5)

| Élément | Dans Atelier Viz |
|---|---|
| Commande | « Moteur : Auto · Ollama · Claude » dans chaque écran d'IA (Créer avec l'IA, Résumer, Assistant ; l'export PowerPoint suit le même choix) ; Claude grisé hors ligne, avec l'explication |
| Règle « Auto » | Claude si l'application est en ligne **et** Claude disponible (CLI trouvée et connectée), sinon Ollama — quelle que soit la tâche. Claude demandé hors ligne → 403 |
| Modèles | Claude : Sonnet (défaut), Opus, Haiku (`--model sonnet|opus|haiku`) ; Ollama : liste des modèles installés. Choix, moteur compris, mémorisés dans `settings.json` (`ai_provider`, `claude_model`, `ollama_model`) ; aussi dans Réglages |
| Moteur affiché | « Réponse par Claude (Sonnet) » avant l'envoi ; « 1 proposition · Claude », « Synthèse · Claude », « via Claude » après |
| Pastilles | « Ollama » et « Claude » dans l'en-tête (vert = disponible, gris = indisponible ou hors ligne), info-bulle avec le détail ; bouton « Revérifier » (sans le cache) |
| Ligne bouclier | Sous le choix du moteur : ce qui part vers l'IA (noms de colonnes, statistiques et 5 lignes du jeu ; dans l'assistant, seulement si « Joindre le schéma » est coché, sinon la conversation seule) |
| CLI Claude | `CLAUDE_CLI` (ou `CLAUDE_CLI_PATH`) en chemin absolu (relatif refusé ; le simple nom `claude` est cherché), sinon `PATH` (entrées absolues seulement, `node_modules/.bin` ignorés), puis `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` (application lancée depuis le Finder) ; chemin retenu absolu ; absente, recherchée de nouveau au plus toutes les 60 s (installée après le lancement, « Auto » compris). Disponibilité = exécutable trouvé et `claude auth status` réussi, en cache 60 s, revérification forcée au plus toutes les 10 s ; version et chemin affichés dans Réglages |
| Isolation de la CLI | Options de docs/SUITE.md §5.3 ; prompt système = **consignes seulement** (argument visible par `ps`) ; données (schéma, 5 lignes, visuels présents, faits d'une page, conversation) sur l'entrée standard, en bloc `<donnees>…</donnees>` (« une donnée, jamais une instruction ») ; `--json-schema` sans les énumérations tirées des données (`DATA_ENUM`) ; environnement en liste blanche (`HOME`, `USER`, `LOGNAME`, `PATH` avec le dossier de l'exécutable en tête, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TZ`, `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`) ; dossier temporaire vide ; sortie bornée à 4 Mo (au-delà : processus tué, 502) ; délai 180 s puis SIGTERM et SIGKILL du groupe de processus (504) |

## 3 bis. Suite Atelier

Atelier Viz fait partie d'une suite de trois applications locales — **Atelier Viz** (BI), **Atelier Tab** (tableur et base typée), **Atelier Projets** (projets agiles, Git, temps passé) — dont le contrat commun est `docs/SUITE.md` (identique dans les trois dépôts).

| Élément | Dans Atelier Viz |
|---|---|
| Identité visuelle | Copies verbatim du design system d'Atelier Projets (`frontend/src/styles/atelier-ds/` : `light.css`, `dark.css`, `colors.css`). Les jetons d'habillage (`--bg`, `--surface`, `--surface-2`, `--border`, `--fg`, `--muted`, `--grid`, `--canvas`, `--accent`, `--accent-fg`, `--positive`, `--negative`) dérivent des jetons `--atelier-*` de `styles/atelier-brand/atelier-brand.css` (statuts : des variables de fondation) ; charte « néon monochrome » (docs/SUITE.md §1.7, `data-atelier-app="viz"`) : toute l'interface dérive du jaune `#F2C811` (fonds, surfaces, traits, textes, halos, grille de fond) via les jetons `--atelier-*`, en clair comme en sombre ; accent = signature, texte d'accent `--accent-ink` (≥ 4,5:1), bouton principal plein en clair et en contour néon en sombre. Rayons 6 / 10 / 16 px, pile de polices système (aucune police téléchargée). **Inchangés** : palette de données (`--series-*`, `--seq-*`, `--div-*`) et thèmes de rapport |
| Thème | `<html class="dark" data-theme="dark">` en sombre, `data-theme="light"` sans classe en clair (Clair / Sombre / Système) |
| Navigation | Sélecteur « Suite Atelier » (icône grille, à gauche du titre) : les trois applications locales et Atelier Cuisine (app en ligne, jamais sondée, « En ligne » ; app Mac `fr.ateliercuisine.app` depuis l'app de bureau), la courante cochée et toujours « en marche », état « en marche / arrêtée » des deux autres (`GET /api/health`, `no-cors`, 1,5 s, sans bloquer) — Atelier Tab sondé sur son adresse (`VITE_ATELIER_TAB_URL`, défaut `127.0.0.1:4175`) puis `127.0.0.1:5175` (en parallèle : l'un répond → en marche), Atelier Projets sur son API ; ouverture par `openExternal`. Adresses dans `lib/suite.ts`, surchargeables par `VITE_ATELIER_VIZ_URL`, `VITE_ATELIER_TAB_URL`, `VITE_ATELIER_PROJETS_URL`, `VITE_ATELIER_CUISINE_URL` |
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
| Données | Carte KPI (cible + tendance), Table (tri, total), Matrice (lignes hiérarchiques, colonne pivot, sous-totaux exacts) ; mise en forme conditionnelle des deux (voir ci-dessous) |
| Cartes | Choroplèthe (France régions, France départements, monde ; noms ou codes, français ou anglais), Carte à points (latitude / longitude, taille, couleur) |
| Interactivité | Segment (liste, liste déroulante, vignettes, plage de nombres ou de dates), Bouton d'action, Zone de texte |

Options communes : légende, étiquettes, tri (catégorie / valeur), Top N, format des nombres (compact, décimales, préfixe, suffixe), empilé / 100 %, lissage, marqueurs.

**Règles de lisibilité** (guide dataviz) : palette catégorielle validée pour le daltonisme, ordre fixe, 8 séries max puis « Autres » ; 3 couleurs max pour nuages et cartes à points ; rampe séquentielle à une teinte pour intensités ; divergent bleu/rouge pour hausse/baisse ; **jamais de double axe** ; info-bulles partout ; version sombre dédiée.

### Mise en forme conditionnelle (tables et matrices)

Onglet Format → « Mise en forme conditionnelle », réglée **par mesure** (`options.conditional[clé]`, clé `agg(champ)`) :

| Réglage | Effet |
|---|---|
| Couleur de fond | Dégradé (du plus faible au plus fort, `--seq-500`) ou divergente (`--div-neg` / `--div-pos`, centrée sur 0 si les valeurs le traversent) ; teintes de 8 à 55 % pour garder le texte lisible (≥ 4,5:1, testé en clair et en sombre) |
| Règles | `>`, `≥`, `<`, `≤`, `=`, `entre` → vert, rouge, bleu ou gris (`--cond-*`, indépendants du thème de l'interface), sur le fond ou le texte ; la première vérifiée l'emporte |
| Barres de données | Proportionnelles à la valeur absolue, rouges pour les négatifs |
| Icônes | Signe (▲ positif, ▼ négatif, ● nul) ou tiers (▲ haut, ● milieu, ▼ bas) : la forme porte le sens, pas seulement la couleur |

Calcul sur les cellules **affichées** (matrice : lignes dépliées, hors colonne Total). Export PowerPoint : fond et texte colorés, icônes devant la valeur (pas de barres dans un tableau PowerPoint). Logique pure : `visuals/data/conditional.ts`.

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
| Prompt | Prompt système : catalogue et règles de choix des graphiques (temps → courbes, géographie → carte, part d'un tout ≤ 6 catégories, pas de double axe…), sans donnée. Message de l'utilisateur : bloc `<donnees>` (schéma du jeu : colonnes, statistiques, 5 lignes ; visuels déjà présents) puis la demande |
| Sortie structurée | Claude CLI : `--json-schema` (`structured_output`) ; Ollama : `format` = schéma JSON ; API Claude : schéma dans la consigne + extraction. Les noms de champs sont une énumération des colonnes réelles (retirée de l'argument `--json-schema` de la CLI : ce sont des données ; `repair` valide de toute façon) |
| Validation / réparation | Types et rôles du catalogue, champs existants, agrégation compatible (sinon `count`), période par défaut `month` sur les dates, maximum par rôle, options filtrées, fond de carte déduit du nom du champ |
| Relance | Si un visuel reste invalide, une seconde demande avec la liste des erreurs ; ce qui ne peut être réparé est écarté (HTTP 422 si rien n'est valide) |
| Studio | Cartes de proposition (type, titre, champs par rôle), « Ajouter » / « Tout ajouter », placement automatique en rangées, une seule entrée d'historique (Ctrl+Z) |
| Suggestions | 4 demandes déduites des colonnes du jeu (carte si champ géographique, évolution mensuelle, top 5, tableau croisé), **juste sous la demande** : dépliées au départ, repliées (« Suggestions (4) ») dès qu'un résultat est affiché, toujours un clic plus loin ; un clic lance la demande comme au départ. Placées près de la zone qu'elles remplissent, elles ne repoussent pas le résultat |
| Nouvelle demande | Bouton dans l'en-tête « Votre demande » : vide la zone et retire le résultat affiché (il reste dans l'historique), rouvre les suggestions |
| Historique de la session | « Demandes précédentes (n) », repliable : texte de la demande, heure, nombre de propositions, moteur, nombre de visuels sur la page ; dépliée, ses cartes de proposition (« Ajouter », « Réajouter », « Tout ajouter ») et « Afficher en résultat » (la demande revient dans la zone). Une session par rapport, en mémoire tant que l'application est ouverte (volet fermé / rouvert sans perte, génération en cours comprise) ; 20 demandes au plus (`studio/aiBuilder.ts`) |
| Ajouté / réajout | L'état d'une proposition se **déduit du rapport** (identifiants des visuels créés encore présents, toutes pages) : « Ajouté », sinon « Ajouter », ou « Réajouter » après un Ctrl+Z ou une suppression ; Ctrl+Y la remet « Ajouté ». Tout ajout — courant ou depuis l'historique — repasse par `repair` (`POST /api/ai/visuals/repair`, sans IA) contre le profil **actuel** du jeu : un visuel dont une colonne a disparu est écarté avec la raison, jamais ajouté cassé |
| Moteur | Commande « Auto · Ollama · Claude » + modèle (Sonnet / Opus / Haiku, ou modèle Ollama installé), mémorisés dans les préférences et communs à tous les écrans d'IA (création, résumé, assistant, notes PowerPoint) — voir §3 |
| Confidentialité | Moteur et modèle affichés (« Réponse par Claude (Sonnet) ») ; hors ligne, Claude n'est pas sélectionnable et « Auto » utilise Ollama. Appels CLI sans télémétrie (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`) |
| Habillage | Le volet suit toujours le design system de l'application ; le thème du rapport (variables, `data-theme`, encre) n'est posé que sur la page (test `StudioPage.theme.test.tsx`) |

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

### Calculs dans le temps (« Afficher la valeur comme »)

Sur toute valeur d'un visuel (puits Valeurs → « Afficher »), sans écrire de formule : `FieldBinding.show` / `Measure.show = { kind, date, window }`, clé `agg(champ)@kind` (`@moving_avg3` pour la moyenne mobile).

| Calcul | Sens |
|---|---|
| Cumul depuis le début de l'année (`ytd`) · cumul depuis le début (`running`) | Accumulation jusqu'à la fin de chaque période |
| Même période l'an dernier (`prev_year`) · écart (`yoy_diff`) · évolution % (`yoy_pct`) | Lignes de l'an dernier décalées d'un an |
| Moyenne mobile (`moving_avg`, 2 à 12 périodes) | Moyenne des N dernières périodes de l'axe |
| Part du total (`pct_total`) | Valeur / total général filtré |

- **Avec un axe de dates** : une valeur par période ; les filtres de date limitent les périodes affichées, pas l'accumulation (le cumul de juin inclut janvier même si le filtre commence en avril). **Sans axe de dates** (KPI, table par région) : la période se termine à la dernière date retenue par les filtres de date. Sous-totaux des matrices calculés ensemble par ensemble.
- Champ date : celui de l'axe du visuel, sinon le premier du jeu (modifiable). Fonctionne aussi sur les mesures et colonnes calculées.
- Pourcentages renvoyés en points et affichés « 12,5 % » valeur par valeur ; jamais additionnés dans un total de table ni dans les constats du résumé IA.
- Moteur : `app/services/engine/showas.py` (requête habituelle jointe à une sous-requête par calcul, sans texte du client) ; garde-fou contre les cumuls démesurés (30 M de lignes intermédiaires). Tests comparés à pandas : `tests/test_showas.py`.

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

### Relations entre jeux de données

Volet Données → **Relier** (ou page Données → **Relations**) : chaque ligne d'un jeu (« plusieurs », ex. les ventes) est reliée à **une** ligne d'un autre jeu (« un », ex. les régions) par une colonne commune.

| | Comportement |
|---|---|
| Modèle | `DatasetModel.relations` : `name` (sans point), `dataset_id`, `from_column` (colonne d'origine du jeu), `to_column`, `columns` (reprises ; toutes si `null`) ; 10 relations au plus par jeu |
| Colonnes liées | Ajoutées à la vue `v_<id>` sous `<relation>.<colonne>` (`ColumnProfile.related`), utilisables partout comme les autres (axe, légende, filtre, segment, colonne calculée) ; groupées sous le nom de la relation dans le volet |
| Jointure | `LEFT JOIN` sur le jeu lié **dédoublonné sur sa clé** (première ligne retenue) : une relation ne multiplie jamais les lignes, les totaux restent justes. Clés de types différents comparées comme du texte |
| Chaînes | Le jeu lié est lu par sa propre vue : ses colonnes liées suivent (`regions.pays.nom`). Cycles, auto-relation, colonnes inconnues et noms en double refusés (422) |
| Filtres | Propagation à sens unique, du « un » vers le « plusieurs » : un segment ou un filtrage croisé posé sur un visuel du jeu régions filtre les visuels du jeu ventes (par la colonne liée `regions.<champ>`) |
| Diagnostic | `POST /api/datasets/{id}/relations/check` pendant la saisie : lignes sans correspondance (exemples), clés en double côté « un » |
| Mise à jour | Modèle ou données du jeu lié modifiés (actualisation comprise) : vues des jeux dépendants recréées et visuels rechargés ; jeu lié supprimé : relation retirée des jeux dépendants |

Exemple : `samples/regions.csv` (13 régions : code, responsable, objectif de CA 2026, population) est relié automatiquement à `ventes_2026.csv` et `magasins.csv` à l'import des exemples.

### Préparation des données (à la Power Query)

Page Données → **Préparer** : éditeur plein écran avec la liste des **étapes appliquées** (Source puis étapes numérotées, cliquables pour voir l'aperçu à cette étape, modifiables, supprimables), une barre de transformations et l'aperçu des 20 premières lignes (clic sur l'en-tête d'une colonne pour la sélectionner). Rien n'est modifié avant **Appliquer**.

| Étape | Effet |
|---|---|
| Renommer · Supprimer des colonnes · Changer le type | Type nombre (« 1 234,50 », « 12,5 % »), date (JJ/MM/AAAA, ISO, numéro de série Excel), texte, booléen (oui / non, vrai / faux, 1 / 0) ; valeur non convertible → vide |
| Filtrer les lignes | Égal, différent, fait partie de, comparaisons (nombres et dates), contient, vide / non vide ; valeurs saisies converties dans le type de la colonne |
| Remplacer des valeurs · Remplir les vides | Cellule entière ou morceau de texte ; valeur fixe ou valeur précédente (« remplir vers le bas ») |
| Nettoyer le texte | Espaces en trop, MAJUSCULES, minuscules, Première Lettre En Majuscule |
| Supprimer les doublons | Lignes identiques ou identiques sur certaines colonnes |
| Dépivoter · Fractionner | Colonnes « Jan, Fév… » → lignes (nom, valeur) ; « Nom Prénom » → deux colonnes |

- Étapes typées (`DatasetProfile.steps`, union discriminée par `kind`) appliquées par `app/services/data/prep.py` (pandas) — jamais de code ni de SQL venant du client ; 50 étapes au plus.
- Source brute gardée dans `raw_<id>` ; les étapes sont **rejouées à chaque actualisation** (connexions, planification). Une étape qui ne tient plus (colonne disparue) bloque l'actualisation (409) sans rien modifier.
- Le modèle (colonnes et mesures calculées, relations) et les relations des autres jeux vers celui-ci sont revalidés sur le résultat : une étape qui les casserait est refusée (422, étape ou relation désignée). L'éditeur signale l'étape fautive et désactive « Appliquer ».
- Un renommage n'est pas répercuté dans les visuels existants (comme dans Power BI).

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
- **Modes** : Édition (volets, déplacement, redimensionnement), Lecture et Présentation.
- **Page d'extraction (drill-through)** : sur une page, sans visuel sélectionné, volet Visualisations → « Page d'extraction » et ses champs (`Page.drillthrough.fields`, 10 au plus). Clic droit sur une barre, une part, une ligne… d'une autre page → menu « Extraire vers « Détail région » » : la page s'ouvre filtrée sur l'élément (filtres transmis par relation, sinon par colonne de même nom), avec un bandeau « Extraction : region = Occitanie · Retour ». L'extraction n'est pas enregistrée (changer de page l'abandonne). Onglet marqué d'une flèche.
- **Présentation** (bouton « Présenter ») : plein écran, page entière à l'écran, flèches / Page suivante / Espace pour avancer, Échap pour quitter ; diaporama automatique (5 à 60 s par diapositive, touche P) des pages ordinaires ou des **signets** ; barre de commande masquée quand la souris est immobile ; clic droit et pages d'extraction disponibles. Le mode d'avant (Édition / Lecture) est rétabli en sortant.
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
| Variation | « Comparer au seuil » : la valeur, sa **variation en %** ou son **écart** depuis l'évaluation précédente (ex. « ≤ -10 % » : baisse d'au moins 10 % d'une actualisation à l'autre) ; la première mesure sert de référence (`last_raw`, note « Référence prise ») |
| Pour chaque | `split_by` : une dimension (texte, date, booléen) ; mesure évaluée par valeur (500 au plus), anti-rebond propre à chaque valeur (`groups`), une notification par valeur qui franchit le seuil (10 au plus par évaluation), webhook avec la liste `valeurs` ; liste : « 2 / 5 » valeurs au-delà du seuil |
| Notification système | `system` (par défaut) : centre de notifications macOS (`osascript`, titre et message en arguments, jamais dans le script) ou `notify-send` (Linux), quand l'application tourne ; « Essayer » dans l'éditeur ; `SYSTEM_NOTIFICATIONS=false` pour couper |
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
| GET / PUT | `/api/settings` | Mode en ligne (`online_mode`), moteur (`ai_provider`), modèles (`claude_model`, `ollama_model`) ; PUT partiel (champs absents gardés) |
| GET | `/api/ai/providers` | État d'Ollama et de Claude (désactivé hors ligne ; modèles au choix, version et chemin de la CLI) ; `?refresh=true` revérifie Claude sans le cache de 60 s (au plus toutes les 10 s) |
| POST | `/api/ai/chat` | Assistant ; `dataset_id` optionnel joint le schéma et 5 lignes au dernier message de l'utilisateur (jamais au prompt système) |
| POST | `/api/ai/visuals` | Phrase + catalogue → visuels validés (`BuildResponse` : visuels, explication, moteur, corrections) |
| POST | `/api/ai/visuals/repair` | Visuels de l'historique « Créer avec l'IA » revalidés contre le profil actuel (un résultat par visuel : réparé ou écarté avec la raison), sans appel à l'IA |
| POST | `/api/ai/summary` | Faits d'une page → synthèse vérifiée (`SummaryResponse` : titre, points reliés aux visuels, moteur, éléments écartés) |
| POST | `/api/datasets` | Import multipart (CSV/XLSX/JSON, 50 Mo) → profil ; persisté dans DuckDB |
| GET | `/api/datasets` · `/api/datasets/{id}` · `/api/datasets/{id}/rows` | Liste, profil, lignes paginées |
| DELETE | `/api/datasets/{id}` | Suppression (table et vue) |
| PUT | `/api/datasets/{id}/model` | Relations, colonnes et mesures calculées : validation complète, vue recréée, profil mis à jour (422 + liste d'erreurs sinon) |
| POST | `/api/datasets/{id}/model/check` | Vérification d'une expression pendant la saisie : erreur localisée, type, aperçu |
| PUT | `/api/datasets/{id}/steps` | Étapes de préparation : appliquées à la source brute, modèle revalidé (422 + étape / relation fautive sinon) |
| POST | `/api/datasets/{id}/steps/preview` | Aperçu des étapes sans enregistrer : lignes, colonnes profilées, 20 lignes, étape fautive |
| POST | `/api/datasets/{id}/relations/check` | Diagnostic d'une relation : lignes avec correspondance, clés en double, exemples sans correspondance |
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

Toutes les routes passent par le garde « requêtes locales » (§3) : `Host` de bouclage ou `ALLOWED_HOSTS`, `Origin` locale ou absente pour les écritures, sinon 403.

Sécurité du moteur : aucun SQL ne vient du client ; champs validés contre le schéma, identifiants entre guillemets, valeurs en paramètres liés (test d'injection inclus).

## 8. Exigences non fonctionnelles
- Fonctionne sans Internet (aucune ressource externe au chargement).
- Secrets uniquement côté backend (`.env`).
- Tests : pytest (320, + 2 sur serveurs réels) côté back, Vitest (170) côté front ; parcours vérifiés dans un vrai navigateur (Playwright) ; fichiers PowerPoint validés et rendus.
- Accessibilité : noms accessibles des visuels = titre affiché, navigation clavier dans les volets, couleurs jamais seules porteuses de sens (légendes, libellés).
- Performance : 10 000 lignes importées et profilées en 0,17 s ; agrégations DuckDB.

## 9. Roadmap
- **Jalon 0 — Socle** ✅ · **0b — Claude via la CLI** ✅ · **1 — Import et profilage** ✅
- **Jalon 2 — Studio** ✅ : DuckDB, rapports multi-pages, 22 visuels, segments, filtres, filtrage croisé, cartes hors ligne, boutons d'automatisation, mode hors ligne / en ligne.
- **Jalon 2 bis — Thèmes** ✅ : thème de l'application (clair / sombre / système), thèmes de rapport, styles par visuel, couleurs hexadécimales, import de thèmes Power BI.
- **Jalon 3 — IA qui construit** ✅ : « Crée un graphique du CA par région » → visuels validés ajoutés au Studio (Claude via `claude -p --json-schema`, Ollama en format JSON). Résumé de page vérifié chiffre par chiffre, insérable dans le rapport et dans les notes PowerPoint.
- **Jalon 4 — Export PowerPoint** ✅ : diapositives 16:9, graphiques et tableaux natifs modifiables, images pour les visuels sans équivalent, thème du rapport, notes avec les filtres. Reste : export PDF et image d'une page.
- **Jalon 5 — Modélisation** ✅ : mesures et colonnes calculées (langage analysé et compilé, jamais de SQL brut), hiérarchies et exploration (drill-down), hiérarchie de dates, relations entre jeux de données (plusieurs-à-un, filtres propagés).
- **Jalon 5 bis — Placement libre** ✅ : visuels au pixel près n'importe où sur la page (taille de page en px, repères d'alignement, poignées, clavier, saisie X/Y/L/H, superposition et ordre, zoom), conversion automatique des anciens rapports.
- **Jalon 5 ter — Connecteurs** ✅ : SQL Server, PostgreSQL, MySQL / MariaDB, SQLite, fichiers OneDrive / SharePoint synchronisés, SharePoint Online (fichiers et listes), en lecture seule, secrets au trousseau, actualisation. Reste : actualisation planifiée, Excel / CSV sur un serveur HTTP, Snowflake / BigQuery.
- **Jalon 5 quater — Application Mac** ✅ : « Atelier Viz.app » à double-cliquer (fenêtre native, icône, Dock), interface servie par l'API, enregistrement natif des fichiers.
- **Jalon 5 quinquies — Suite Atelier** ✅ : design system commun (copies verbatim, jetons dérivés, accent violet), thème `data-theme` + `dark`, sélecteur « Suite Atelier » avec état des API, import des enveloppes DataFlow, connecteurs Atelier Tab (instantanés) et Atelier Projets (API locale), actualisables (`docs/SUITE.md`).
- **Jalon 6 — Partage et automatisation** ✅ : signets (volet, bouton d'action), actualisation planifiée des sources (ordonnanceur, journal, rechargement des visuels), alertes sur seuil (anti-rebond, notifications, webhook), synchronisation des rapports avec un dépôt GitHub (un commit par envoi, conflits jamais écrasés). Reste : signets personnels / groupes de signets et diaporama de signets ; notifications par e-mail ; historique Git d'un rapport et restauration d'une version ; GitHub Enterprise (URL d'API configurable) ; actualisation planifiée quand l'application est fermée (service système).
- **Jalon 6 bis — IA de la suite** ✅ : choix du moteur commun à la Suite Atelier (Auto · Ollama · Claude, modèles Sonnet / Opus / Haiku et Ollama mémorisés, CLI trouvée hors du `PATH`), volet « Créer avec l'IA » avec suggestions toujours accessibles, nouvelle demande, historique de la session et réajout revalidé ; indicateur « en marche » d'Atelier Tab.
- **Jalon 6 ter — Durcissement local** ✅ : garde « requêtes locales » (Host / Origin, `ALLOWED_HOSTS`), `fastapi>=0.132` ; CLI Claude conforme à docs/SUITE.md §5.3 (environnement en liste blanche, exécutable absolu, aucune donnée en argument, sortie bornée, arrêt forcé, revérification limitée) ; préférences écrites sous verrou ; lanceur macOS sans `npm install` ; santé d'Atelier Tab dérivée de `VITE_ATELIER_TAB_URL`.
- **Charte néon monochrome** ✅ : toute l'application dans la couleur signature jaune, en clair et en sombre (fond teinté avec fine grille, cartes cerclées d'un trait néon avec halo, bouton principal plein / contour néon, navigation active avec barre de couleur), marque commune v3 ; palette de données et thèmes de rapport inchangés.
- **Jalon 7 — Analyse avancée** (en cours) : mise en forme conditionnelle des tables et matrices ✅, calculs dans le temps (« Afficher la valeur comme » : cumul annuel, N-1, évolution, moyenne mobile, part du total) ✅, relations entre jeux ✅, préparation des données (étapes rejouées à l'actualisation) ✅, pages d'extraction (clic droit) et mode présentation (plein écran, diaporama de pages ou de signets) ✅, alertes sur variation et « pour chaque » valeur d'une dimension, notifications système ✅.
