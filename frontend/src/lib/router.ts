/** Routeur minimal par hash (#/…) : adapté à une application locale, sans dépendance. */

import { useEffect, useState } from "react";

export type Route =
  | { name: "reports" }
  | { name: "studio"; id: string }
  | { name: "data" }
  | { name: "automation" }
  | { name: "settings" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  const studio = /^\/rapports\/([0-9a-f]{12})$/.exec(path);
  if (studio?.[1]) return { name: "studio", id: studio[1] };
  if (path === "/donnees") return { name: "data" };
  if (path === "/reglages") return { name: "settings" };
  if (path === "/automatisation") return { name: "automation" };
  return { name: "reports" };
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
