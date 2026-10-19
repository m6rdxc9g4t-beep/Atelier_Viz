/**
 * Fonds de carte hors ligne (empaquetés dans l'application, chargés à la demande) :
 * - France : régions et départements métropolitains (france-geojson, Licence Ouverte Etalab) ;
 * - Monde : pays (world-atlas / Natural Earth, domaine public).
 */

import type { Feature, FeatureCollection, Geometry } from "geojson";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

export type GeoLayer = "fr-regions" | "fr-departements" | "world";

export const GEO_LAYERS: { value: GeoLayer; label: string }[] = [
  { value: "fr-regions", label: "France — régions" },
  { value: "fr-departements", label: "France — départements" },
  { value: "world", label: "Monde — pays" },
];

type Props = { nom?: string; code?: string; name?: string };
export type GeoFeature = Feature<Geometry, Props> & { id?: string | number };

const cache = new Map<GeoLayer, Promise<FeatureCollection<Geometry, Props>>>();

export function loadLayer(layer: GeoLayer): Promise<FeatureCollection<Geometry, Props>> {
  let p = cache.get(layer);
  if (!p) {
    p = (async () => {
      if (layer === "fr-regions") return (await import("../../assets/geo/fr-regions.json")).default as FeatureCollection<Geometry, Props>;
      if (layer === "fr-departements")
        return (await import("../../assets/geo/fr-departements.json")).default as FeatureCollection<Geometry, Props>;
      const topo = (await import("world-atlas/countries-110m.json")).default as unknown as Topology<{
        countries: GeometryCollection<Props>;
      }>;
      return feature(topo, topo.objects.countries) as FeatureCollection<Geometry, Props>;
    })();
    cache.set(layer, p);
  }
  return p;
}

/** « Île-de-France » → « ile de france » : comparaison sans accents, casse ni ponctuation. */
export function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Noms français → noms anglais (Natural Earth) des pays les plus courants. */
const FR_COUNTRIES: Record<string, string> = {
  "afrique du sud": "South Africa", algerie: "Algeria", allemagne: "Germany", "arabie saoudite": "Saudi Arabia",
  argentine: "Argentina", australie: "Australia", autriche: "Austria", belgique: "Belgium", bresil: "Brazil",
  bulgarie: "Bulgaria", cameroun: "Cameroon", canada: "Canada", chili: "Chile", chine: "China", colombie: "Colombia",
  "coree du sud": "South Korea", "cote d ivoire": "Côte d'Ivoire", croatie: "Croatia", danemark: "Denmark",
  egypte: "Egypt", "emirats arabes unis": "United Arab Emirates", espagne: "Spain", "etats unis": "United States of America",
  usa: "United States of America", finlande: "Finland", france: "France", grece: "Greece", hongrie: "Hungary",
  inde: "India", indonesie: "Indonesia", irlande: "Ireland", islande: "Iceland", israel: "Israel", italie: "Italy",
  japon: "Japan", kenya: "Kenya", luxembourg: "Luxembourg", madagascar: "Madagascar", maroc: "Morocco",
  mexique: "Mexico", nigeria: "Nigeria", norvege: "Norway", "nouvelle zelande": "New Zealand", "pays bas": "Netherlands",
  perou: "Peru", philippines: "Philippines", pologne: "Poland", portugal: "Portugal", "republique tcheque": "Czechia",
  tchequie: "Czechia", roumanie: "Romania", "royaume uni": "United Kingdom", russie: "Russia", senegal: "Senegal",
  serbie: "Serbia", slovaquie: "Slovakia", suede: "Sweden", suisse: "Switzerland", thailande: "Thailand",
  tunisie: "Tunisia", turquie: "Turkey", ukraine: "Ukraine", vietnam: "Vietnam", "viet nam": "Vietnam",
};

/** Clés de rapprochement d'une entité géographique (nom, code, alias). */
export function featureKeys(f: GeoFeature): string[] {
  const p = f.properties ?? {};
  const keys = [p.nom, p.code, p.name, f.id].filter((k) => k !== undefined && k !== null).map(normalize);
  if (p.code) keys.push(normalize(String(Number(p.code)))); // « 01 » ↔ « 1 »
  return keys;
}

export function aliasOf(value: string): string {
  const n = normalize(value);
  return FR_COUNTRIES[n] ? normalize(FR_COUNTRIES[n]) : n;
}

export function featureName(f: GeoFeature): string {
  return f.properties?.nom ?? f.properties?.name ?? String(f.id ?? "");
}
