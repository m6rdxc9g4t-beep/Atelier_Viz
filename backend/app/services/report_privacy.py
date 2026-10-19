"""Valeurs « privées » d'un rapport : retrait avant partage, restauration à la récupération.

Un rapport (fichier JSON) ne contient pas les tables des jeux, mais certaines options en recopient
des valeurs réelles, et un bouton webhook peut porter une adresse secrète :

- filtres de page et filtres propres à un visuel (`filters[].values`) ;
- sélection des segments (`options.selected`, `options.range`) et chemin d'exploration (`options.drill`) ;
- signets : filtres, sélections et exploration capturés, filtrage croisé (`selection`) ;
- adresse des boutons « Appeler un webhook » (`options.url`, souvent porteuse d'un jeton).

`strip_private` retire ces champs (copie) ; `restore_private` les reprend du poste pour chaque page,
visuel ou signet qui existe déjà localement (fusion explicite : en mode nettoyage, ces champs sont
**locaux** et ne sont jamais pris du dépôt pour un élément existant ; un élément nouveau garde ce que
contient le fichier reçu).
"""

from typing import Any

from app.schemas.report import Bookmark, BookmarkPageState, Page, Report, Visual

#: Options de visuel qui recopient des valeurs des données.
VALUE_OPTIONS = ("selected", "range", "drill")


def _is_webhook_button(visual: Visual) -> bool:
    return visual.type == "button" and visual.options.get("action") == "webhook"


def _strip_visual(visual: Visual) -> None:
    visual.filters = []
    for key in VALUE_OPTIONS:
        visual.options.pop(key, None)
    if _is_webhook_button(visual):
        visual.options.pop("url", None)


def _strip_bookmark(bookmark: Bookmark) -> None:
    bookmark.selection = None
    for state in bookmark.pages.values():
        state.filters = []
        for vs in state.visuals.values():
            vs.selected = vs.range = vs.drill = None


def strip_private(report: Report) -> Report:
    """Copie du rapport sans filtres, sélections, exploration ni adresses de webhook (structure intacte)."""
    out = report.model_copy(deep=True)
    for page in out.pages:
        page.filters = []
        for visual in page.visuals:
            _strip_visual(visual)
    for bookmark in out.bookmarks:
        _strip_bookmark(bookmark)
    return out


def _restore_visual(visual: Visual, local: Visual) -> None:
    visual.filters = [f.model_copy(deep=True) for f in local.filters]
    options: dict[str, Any] = {k: v for k, v in visual.options.items() if k not in VALUE_OPTIONS}
    for key in VALUE_OPTIONS:
        if key in local.options:
            options[key] = local.options[key]
    if _is_webhook_button(visual):
        options.pop("url", None)
        if "url" in local.options:
            options["url"] = local.options["url"]
    visual.options = options


def _restore_bookmark(bookmark: Bookmark, local: Bookmark) -> None:
    bookmark.selection = local.selection.model_copy(deep=True) if local.selection else None
    for page_id, state in bookmark.pages.items():
        mine: BookmarkPageState | None = local.pages.get(page_id)
        if mine is None:
            continue
        state.filters = [f.model_copy(deep=True) for f in mine.filters]
        for visual_id, vs in state.visuals.items():
            own = mine.visuals.get(visual_id)
            if own is not None:
                vs.selected, vs.range, vs.drill = own.selected, own.range, own.drill


def restore_private(incoming: Report, local: Report) -> Report:
    """Copie de `incoming` dont les champs privés viennent de `local` pour les éléments existants."""
    out = incoming.model_copy(deep=True)
    local = local.model_copy(deep=True)
    pages: dict[str, Page] = {p.id: p for p in local.pages}
    visuals: dict[str, Visual] = {v.id: v for p in local.pages for v in p.visuals}
    for page in out.pages:
        mine = pages.get(page.id)
        if mine is not None:
            page.filters = mine.filters
        for visual in page.visuals:
            own = visuals.get(visual.id)
            if own is not None:
                _restore_visual(visual, own)
    marks: dict[str, Bookmark] = {b.id: b for b in local.bookmarks}
    for bookmark in out.bookmarks:
        own_mark = marks.get(bookmark.id)
        if own_mark is not None:
            _restore_bookmark(bookmark, own_mark)
    return out
