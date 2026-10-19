/**
 * Matrice (tableau croisé) : construction de la requête GROUPING SETS et de l'arbre de lignes.
 *
 * Les sous-totaux et totaux viennent du moteur (GROUPING SETS DuckDB) et sont donc exacts
 * pour toutes les agrégations (une moyenne de groupe n'est pas une moyenne de moyennes).
 */

import type { Scalar } from "../../types/dataset";
import type { Filter, QueryRequest } from "../../types/query";
import type { FieldBinding } from "../../types/report";
import { valueKey } from "../common";
import { bindingKey, dimension, measure } from "../fields";
import type { Row } from "../useQueryResult";

export function matrixQuery(
  datasetId: string,
  rows: FieldBinding[],
  column: FieldBinding | undefined,
  values: FieldBinding[],
  filters: Filter[],
): QueryRequest {
  const rowKeys = rows.map(bindingKey);
  const colKey = column ? bindingKey(column) : null;
  const sets: string[][] = [];
  for (let k = rows.length; k >= 0; k--) {
    const prefix = rowKeys.slice(0, k);
    if (colKey) sets.push([...prefix, colKey]);
    sets.push(prefix);
  }
  return {
    dataset_id: datasetId,
    dimensions: [...rows, ...(column ? [column] : [])].map(dimension),
    measures: values.map(measure),
    filters,
    grouping_sets: sets,
    limit: 20000,
  };
}

export interface MatrixNode {
  path: string;
  level: number; // 0 = total général, 1 = premier niveau…
  value: Scalar;
  /** Valeurs par colonne (clé de valeur de colonne, ou "__total") puis par mesure. */
  cells: Map<string, Row>;
  children: MatrixNode[];
}

export interface MatrixModel {
  root: MatrixNode;
  columns: Scalar[];
}

/** Arbre des lignes à partir du résultat GROUPING SETS. */
export function buildMatrix(result: Row[], rows: FieldBinding[], column: FieldBinding | undefined): MatrixModel {
  const n = rows.length;
  const dims = n + (column ? 1 : 0);
  const rowKeys = rows.map(bindingKey);
  const colKey = column ? bindingKey(column) : null;
  const bit = (j: number) => 1 << (dims - 1 - j);

  const root: MatrixNode = { path: "", level: 0, value: null, cells: new Map(), children: [] };
  const nodes = new Map<string, MatrixNode>([["", root]]);
  const columns = new Map<string, Scalar>();

  const nodeFor = (values: Scalar[]): MatrixNode => {
    let parent = root;
    for (let i = 0; i < values.length; i++) {
      const path = values.slice(0, i + 1).map(valueKey).join("§");
      let node = nodes.get(path);
      if (!node) {
        node = { path, level: i + 1, value: values[i] ?? null, cells: new Map(), children: [] };
        nodes.set(path, node);
        parent.children.push(node);
      }
      parent = node;
    }
    return parent;
  };

  for (const r of result) {
    const g = Number(r.__grouping ?? 0);
    let level = 0;
    while (level < n && (g & bit(level)) === 0) level++;
    const colAggregated = column ? (g & bit(n)) !== 0 : true;
    const node = nodeFor(rowKeys.slice(0, level).map((k) => r[k] ?? null));
    let cellKey = "__total";
    if (!colAggregated && colKey) {
      const v = r[colKey] ?? null;
      cellKey = valueKey(v);
      columns.set(cellKey, v);
    }
    node.cells.set(cellKey, r);
  }

  const sortTree = (node: MatrixNode) => {
    node.children.sort((a, b) => compare(a.value, b.value));
    node.children.forEach(sortTree);
  };
  sortTree(root);
  return { root, columns: [...columns.values()].sort(compare) };
}

function compare(a: Scalar, b: Scalar): number {
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "fr", { numeric: true });
}
