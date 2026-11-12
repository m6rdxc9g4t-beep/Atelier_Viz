import { describe, expect, it } from "vitest";

import { TOOLBAR_HEIGHT, toolbarSide } from "./toolbar";

const PAGE = { width: 1280, height: 720 };

describe("barre d'actions d'un visuel", () => {
  it("se pose au-dessus du cadre quand la page a la place", () => {
    expect(toolbarSide({ x: 248, y: 60, w: 247, h: 116 }, PAGE)).toBe("above");
    expect(toolbarSide({ x: 0, y: TOOLBAR_HEIGHT, w: 100, h: 100 }, PAGE)).toBe("above");
  });

  it("passe dessous pour un visuel collé en haut de la page", () => {
    expect(toolbarSide({ x: 700, y: 8, w: 572, h: 44 }, PAGE)).toBe("below");
    expect(toolbarSide({ x: 0, y: 0, w: 100, h: 720 - TOOLBAR_HEIGHT }, PAGE)).toBe("below");
  });

  it("reste dans le cadre seulement quand le visuel occupe toute la hauteur", () => {
    expect(toolbarSide({ x: 8, y: 8, w: 216, h: 704 }, PAGE)).toBe("inside");
    expect(toolbarSide({ x: 0, y: 0, w: 1280, h: 720 }, PAGE)).toBe("inside");
  });
});
