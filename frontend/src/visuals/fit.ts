/**
 * Place dont un contenu a besoin (logique pure, sans DOM) : largeur d'un texte en Inter, abréviation par la
 * fin, axes des graphiques, hauteurs et largeurs minimales des visuels du gabarit généré.
 *
 * Les composants s'en servent pour ne rien rogner (axe assez large, dernière étiquette dans le cadre) et
 * `studio/starter.ts` pour donner à chaque visuel la place de son contenu.
 */

/** Largeurs (en em) des caractères d'Inter, mesurées dans le navigateur et arrondies au-dessus. */
const NARROW = new Set([..."iljI.,:;'|! "]);
const SLIM = new Set([..."ftr/()[]-"]);
const WIDE = new Set([..."mwMW%@"]);

function charEm(ch: string): number {
  if (NARROW.has(ch)) return 0.3;
  if (ch === "-") return 0.46;
  if (SLIM.has(ch)) return 0.38;
  if (WIDE.has(ch)) return ch === "W" || ch === "%" ? 1.01 : 0.9;
  if (ch >= "0" && ch <= "9") return 0.64;
  if (ch === "€" || ch === "…") return 0.68;
  if (ch === "—") return 1;
  // Capitales (accentuées comprises) : plus larges que les minuscules.
  if (ch !== ch.toLowerCase()) return 0.7;
  return 0.58;
}

/**
 * Largeur approximative d'un texte en Inter, en pixels. Volontairement un peu large (jamais plus de
 * quelques pour cent sous la largeur réelle) : sert à réserver de la place, pas à mesurer.
 */
export function textWidth(text: string, fontSize: number, bold = false): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * fontSize * (bold ? 1.06 : 1);
}

/** Abrège un texte par la fin (« … ») pour qu'il tienne dans `maxWidth` ; le texte complet reste en info-bulle. */
export function truncateEnd(text: string, maxWidth: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && textWidth(`${chars.join("").trimEnd()}…`, fontSize) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

// ─── Axes des graphiques ────────────────────────────────────────────────────────────────────────────────

/** Taille des étiquettes d'axe (voir `AXIS` de `common.tsx`). */
export const AXIS_FONT = 11;
/**
 * Place à ajouter au texte d'une graduation : trait et marge de Recharts (8 px), plus une réserve, car
 * Recharts passe à la ligne un libellé qu'il mesure plus large que l'axe.
 */
const TICK_GAP = 14;
const TICK_SLACK = 1.05;
/** Largeur maximale de l'axe des catégories d'un graphique en barres horizontales. */
export const CATEGORY_AXIS_MAX = 180;

/**
 * Axe des catégories des barres horizontales : assez large pour le libellé le plus long (les chiffres
 * comptent autant que les lettres), borné ; au-delà seulement, les libellés sont abrégés par la fin.
 */
export function categoryAxis(labels: string[], max = CATEGORY_AXIS_MAX): { width: number; format: (label: string) => string } {
  const longest = labels.reduce((m, l) => Math.max(m, textWidth(l, AXIS_FONT)), 0);
  const needed = Math.ceil(longest * TICK_SLACK) + TICK_GAP;
  const width = Math.min(max, Math.max(48, needed));
  return { width, format: needed <= max ? (label) => label : (label) => truncateEnd(label, (width - TICK_GAP) / TICK_SLACK, AXIS_FONT) };
}

/**
 * Marge droite d'un graphique dont le dernier point est au bord (lignes, aires) : la dernière étiquette,
 * centrée sur ce point, dépasse de la moitié de sa largeur.
 */
export function lastTickMargin(lastLabel: string | undefined, min = 12): number {
  if (!lastLabel) return min;
  return Math.max(min, Math.ceil(textWidth(lastLabel, AXIS_FONT) / 2) + 2);
}

/** Marge droite des barres horizontales étiquetées : la place de l'étiquette de valeur la plus longue. */
export function valueLabelMargin(labels: string[], min = 28): number {
  const longest = labels.reduce((m, l) => Math.max(m, textWidth(l, 10)), 0);
  return Math.max(min, Math.ceil(longest) + 8);
}

/** Taille des étiquettes de valeur et écart que Recharts laisse entre une barre (ou un point) et son étiquette. */
const VALUE_LABEL_FONT = 10;
const VALUE_LABEL_OFFSET = 5;

/**
 * Marge haute d'un graphique vertical : avec des étiquettes de valeur, la hauteur d'une étiquette posée sur la
 * plus haute colonne (elle touche le haut du tracé quand sa valeur est le maximum de l'axe), sinon `min`.
 */
export function valueLabelTopMargin(labels: boolean, min = 8): number {
  return labels ? Math.max(min, Math.ceil(VALUE_LABEL_FONT * 1.2) + VALUE_LABEL_OFFSET + 1) : min;
}

// ─── Place minimale des visuels (gabarit généré) ───────────────────────────────────────────────────────

/** Marges intérieures du cadre d'un visuel (12 px de chaque côté) et hauteur de sa ligne de titre. */
export const FRAME_PADDING = 24;
export const TITLE_HEIGHT = 26;

/** Carte KPI : titre, valeur sur une ligne et, avec une mini-tendance, une courbe d'au moins 28 px. */
export function kpiMinHeight(trend: boolean): number {
  return FRAME_PADDING + TITLE_HEIGHT + 34 + (trend ? 32 : 0);
}

/** Tableaux et matrices : hauteur de la ligne d'en-tête (celle du total est la même) et d'une ligne de données. */
export const TABLE_HEAD_HEIGHT = 29;
export const TABLE_ROW_HEIGHT = 25;

/**
 * Hauteur qu'il faut à un tableau (ou une matrice) pour montrer `rows` lignes sans défilement : cadre, titre,
 * en-tête, lignes et, s'il y en a un, total posé sous la zone défilante.
 */
export function tableMinHeight(rows: number, totals: boolean): number {
  // 2 px : filet sous l'en-tête et arrondi des hauteurs de ligne.
  return FRAME_PADDING + TITLE_HEIGHT + 2 + TABLE_HEAD_HEIGHT + Math.max(0, rows) * TABLE_ROW_HEIGHT + (totals ? TABLE_HEAD_HEIGHT : 0);
}

/**
 * Hauteur qu'il faut à des barres horizontales : cadre, titre, axe des valeurs et 14 px par barre (chaque
 * barre a son libellé de 11 px : en dessous, les libellés se toucheraient).
 */
export function barsMinHeight(bars: number): number {
  return FRAME_PADDING + TITLE_HEIGHT + 30 + Math.max(1, bars) * 14;
}

/** Largeur qu'il faut à un champ de date pour montrer l'année entière (Safari : « 12 / 11 / 2026 »). */
export const DATE_INPUT_WIDTH = 120;
/** Largeur intérieure à partir de laquelle les deux champs d'une plage tiennent côte à côte. */
export const RANGE_SIDE_BY_SIDE = 2 * DATE_INPUT_WIDTH + 8;

/** Segment « plage » : deux champs côte à côte s'il y a la place, sinon l'un sous l'autre (plus haut). */
export function rangeSlicerMinHeight(width: number): number {
  const stacked = width - FRAME_PADDING < RANGE_SIDE_BY_SIDE;
  // Champs (26 px chacun), libellés au-dessus quand ils sont côte à côte, puis l'étendue des données.
  const fields = stacked ? 26 * 2 + 6 : 16 + 4 + 26;
  const note = stacked ? 30 : 15;
  return FRAME_PADDING + TITLE_HEIGHT + fields + 8 + note + 4;
}

/** Taille du texte des onglets du navigateur de pages, marge horizontale d'un onglet, écart entre onglets. */
const NAV_FONT = 14;
const NAV_TAB_PADDING = 12 * 2 + 2;
export const NAV_GAP = 4;

/** Largeur d'un onglet qui montre le nom entier d'une page (en gras : l'onglet courant est le plus large). */
export function navigatorTabWidth(name: string): number {
  return Math.ceil(textWidth(name, NAV_FONT, true)) + NAV_TAB_PADDING;
}

/** Largeur qu'il faut à un navigateur horizontal pour montrer le nom entier de chaque page. */
export function navigatorWidth(names: string[]): number {
  const tabs = names.reduce((s, n) => s + navigatorTabWidth(n), 0);
  // 12 px : marge intérieure du cadre « nu » du navigateur (6 px de chaque côté).
  return tabs + NAV_GAP * Math.max(0, names.length - 1) + 12;
}

/**
 * Largeur sous laquelle chaque onglet d'un navigateur horizontal de `width` px (intérieur) ne descend pas :
 * celle de son nom, sans dépasser une part égale. Quand la place manque, un nom court reste donc entier et
 * seuls les noms plus longs qu'une part égale sont abrégés, jamais plus qu'à largeur égale.
 */
export function navigatorTabMins(names: string[], width: number): number[] {
  const share = Math.max(0, (width - NAV_GAP * Math.max(0, names.length - 1)) / Math.max(1, names.length));
  return names.map((n) => Math.min(navigatorTabWidth(n), share));
}

/** La même borne en CSS, pour un navigateur de n'importe quelle largeur (`100%` = sa largeur intérieure). */
export function navigatorTabMinCss(name: string, count: number): string {
  return `min(${navigatorTabWidth(name)}px, calc((100% - ${NAV_GAP * Math.max(0, count - 1)}px) / ${Math.max(1, count)}))`;
}
