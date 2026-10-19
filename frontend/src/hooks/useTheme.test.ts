import { describe, expect, it } from "vitest";

import { applyThemeMarkers } from "./useTheme";

describe("thème de l'application (docs/SUITE.md §1.5)", () => {
  it("pose la classe dark ET data-theme", () => {
    const root = document.createElement("html");
    applyThemeMarkers("dark", root);
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyThemeMarkers("light", root);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.getAttribute("data-theme")).toBe("light");
  });
});
