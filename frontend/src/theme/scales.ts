/**
 * Couleurs d'intensité (séquentielle, divergente, statuts) en hexadécimal, pour l'export
 * PowerPoint et les vérifications de contraste. À l'écran, on utilise les variables CSS de
 * `index.css` (`--seq-500`, `--div-pos`, `--cond-*`) : ces valeurs en sont la copie exacte (test).
 */

export interface ScaleColors {
  seq: string;
  divPos: string;
  divNeg: string;
  positive: string;
  negative: string;
  accent: string;
  muted: string;
}

export const SCALES: Record<"light" | "dark", ScaleColors> = {
  light: { seq: "#256abf", divPos: "#2a78d6", divNeg: "#e34948", positive: "#0b7a0b", negative: "#d03b3b", accent: "#2a78d6", muted: "#62615c" },
  dark: { seq: "#5598e7", divPos: "#3987e5", divNeg: "#e66767", positive: "#34c78a", negative: "#f06a6a", accent: "#3987e5", muted: "#a6a59c" },
};
