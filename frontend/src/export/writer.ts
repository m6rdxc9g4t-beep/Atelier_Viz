/**
 * Écriture des éléments de diapositive avec pptxgenjs (seul module qui dépend de la bibliothèque).
 *
 * Règles pptxgenjs respectées ici : couleurs sans « # », options jamais partagées entre deux
 * appels (la bibliothèque les modifie en place), `isTextBox` sur les zones de texte, marges nulles.
 */

import type PptxGenJS from "pptxgenjs";

import type { ChartLayer, SlideItem, TextRun } from "./items";

type Pptx = PptxGenJS;
type Slide = PptxGenJS.Slide;

/** Copie profonde : pptxgenjs convertit les unités en place dans les objets d'options. */
const fresh = <T>(value: T): T => structuredClone(value);

const textRuns = (runs: TextRun[]): PptxGenJS.TextProps[] =>
  runs.map((r) => ({ text: r.text, options: fresh(r.options ?? {}) as PptxGenJS.TextPropsOptions }));

function chartType(pptx: Pptx, type: ChartLayer["type"]): PptxGenJS.CHART_NAME {
  return pptx.ChartType[type] as PptxGenJS.CHART_NAME;
}

export function addItems(pptx: Pptx, slide: Slide, items: SlideItem[]): void {
  for (const item of items) addItem(pptx, slide, item);
}

function addItem(pptx: Pptx, slide: Slide, item: SlideItem): void {
  const { x, y, w, h } = item.rect;
  switch (item.kind) {
    case "shape": {
      const shape = item.radius > 0.001 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
      const common = {
        x,
        y,
        w,
        h,
        objectName: item.name,
        fill: item.fill ? { color: item.fill.color, transparency: item.fill.transparency } : { type: "none" as const },
        line: item.line ? { color: item.line.color, width: item.line.width } : { type: "none" as const },
        ...(item.radius > 0.001 ? { rectRadius: item.radius } : {}),
        ...(item.shadow ? { shadow: { type: "outer" as const, blur: 6, offset: 1.5, angle: 90, color: "000000", opacity: 0.12 } } : {}),
      };
      if (item.text) {
        slide.addText(textRuns(item.text.runs), {
          ...common,
          shape,
          fontSize: item.text.fontSize,
          color: item.text.color,
          bold: item.text.bold,
          align: item.text.align ?? "center",
          valign: "middle",
          margin: 2,
        } as PptxGenJS.TextPropsOptions);
      } else {
        slide.addShape(shape, { ...common, ...(item.link ? { hyperlink: fresh(item.link) } : {}) } as PptxGenJS.ShapeProps);
      }
      // Lien sur toute la surface : zone transparente posée par-dessus (pptxgenjs ne lie que le texte d'une zone de texte).
      if (item.link && item.text) {
        slide.addShape(pptx.ShapeType.rect, {
          x,
          y,
          w,
          h,
          objectName: `Lien — ${item.name}`,
          fill: { color: "FFFFFF", transparency: 100 },
          line: { type: "none" },
          hyperlink: { ...fresh(item.link), tooltip: "url" in item.link ? item.link.url : `Diapositive ${item.link.slide}` },
        });
      }
      return;
    }
    case "text":
      slide.addText(textRuns(item.runs), {
        x,
        y,
        w,
        h,
        objectName: item.name,
        isTextBox: true,
        margin: 0,
        fontSize: item.fontSize,
        color: item.color,
        bold: item.bold,
        align: item.align ?? "left",
        valign: item.valign ?? "top",
        ...(item.shrink ? { fit: "shrink" as const } : {}),
      });
      return;
    case "chart": {
      const options = { ...fresh(item.options), x, y, w, h } as PptxGenJS.IChartOpts;
      if (item.layers.length === 1 && item.layers[0]) {
        const layer = item.layers[0];
        slide.addChart(chartType(pptx, layer.type), fresh(layer.data) as PptxGenJS.OptsChartData[], { ...options, ...(fresh(layer.options) as PptxGenJS.IChartOpts) });
      } else {
        const multi = item.layers.map((l) => ({
          type: chartType(pptx, l.type),
          data: fresh(l.data) as PptxGenJS.OptsChartData[],
          options: fresh(l.options) as PptxGenJS.IChartPropsChartBar,
        }));
        // Graphique combiné : le 2e argument est l'objet d'options (la signature typée l'appelle « data »).
        slide.addChart(multi as unknown as PptxGenJS.IChartMulti[], options as unknown as unknown[]);
      }
      return;
    }
    case "table":
      slide.addTable(fresh(item.rows) as PptxGenJS.TableRow[], { ...(fresh(item.options) as PptxGenJS.TableProps), x, y, w, objectName: item.name });
      return;
    case "image":
      slide.addImage({ data: item.data.replace(/^data:/, ""), x, y, w, h, altText: item.name, objectName: item.name });
      return;
  }
}
