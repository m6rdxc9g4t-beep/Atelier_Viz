/**
 * Éléments de diapositive indépendants de pptxgenjs.
 *
 * La conversion d'un visuel produit une liste de descripteurs (forme, texte, graphique, table,
 * image) : c'est testable sans générer de fichier, et `writer.ts` est le seul module qui parle
 * à pptxgenjs. Les couleurs sont déjà au format pptxgenjs (hex sans « # »).
 */

import type { Rect } from "./layout";

export type ChartKind = "bar" | "line" | "area" | "pie" | "doughnut" | "radar" | "scatter" | "bubble";

export interface ChartSeries {
  name: string;
  labels?: string[];
  values: number[];
  sizes?: number[];
}

export interface ChartLayer {
  type: ChartKind;
  data: ChartSeries[];
  options: Record<string, unknown>;
}

export interface TextRun {
  text: string;
  options?: {
    bold?: boolean;
    color?: string;
    fontSize?: number;
    bullet?: boolean | { indent?: number };
    breakLine?: boolean;
    hyperlink?: { url?: string; slide?: number; tooltip?: string };
  };
}

export interface TableCell {
  text: string;
  options?: Record<string, unknown>;
}

export type Link = { url: string } | { slide: number };

export type SlideItem =
  | {
      kind: "shape";
      name: string;
      rect: Rect;
      fill: { color: string; transparency: number } | null;
      line: { color: string; width: number } | null;
      /** Rayon des angles en pouces (0 = rectangle). */
      radius: number;
      shadow: boolean;
      text?: { runs: TextRun[]; fontSize: number; color: string; bold?: boolean; align?: "left" | "center" | "right" };
      link?: Link;
    }
  | {
      kind: "text";
      name: string;
      rect: Rect;
      runs: TextRun[];
      fontSize: number;
      color: string;
      bold?: boolean;
      align?: "left" | "center" | "right";
      valign?: "top" | "middle" | "bottom";
      /** Réduire le texte s'il déborde (PowerPoint « ajuster le texte »). */
      shrink?: boolean;
    }
  | { kind: "chart"; name: string; rect: Rect; layers: ChartLayer[]; options: Record<string, unknown> }
  | { kind: "table"; name: string; rect: Rect; rows: TableCell[][]; options: Record<string, unknown> }
  | { kind: "image"; name: string; rect: Rect; data: string };
