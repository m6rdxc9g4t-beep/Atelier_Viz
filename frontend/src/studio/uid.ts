/** Identifiant court d'une page ou d'un visuel. À part du store : l'accueil en a besoin sans charger le Studio. */
export const uid = (): string => Math.random().toString(36).slice(2, 10);
