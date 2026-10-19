/** Couleurs hexadécimales : validation, mélange, contraste (WCAG). */

export const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

/** « #abc » → « #aabbcc », en minuscules. */
export function normalizeHex(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return v;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = normalizeHex(hex).slice(1);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** Couleur `top` posée avec l'opacité `alpha` (0–1) sur `bottom`. */
export function blend(top: string, bottom: string, alpha: number): string {
  const a = hexToRgb(top);
  const b = hexToRgb(bottom);
  return rgbToHex([0, 1, 2].map((i) => a[i]! * alpha + b[i]! * (1 - alpha)) as [number, number, number]);
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Rapport de contraste WCAG entre deux couleurs (1 à 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const isDarkColor = (hex: string): boolean => luminance(hex) < 0.18;
