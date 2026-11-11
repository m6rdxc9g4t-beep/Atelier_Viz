import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useStudio } from "../studio/store";
import type { Report } from "../types/report";
import { reportDatasetId, useStudioDatasetId } from "./useStudioDataset";

const visual = (dataset_id: string | null) => ({ id: "v", type: "kpi", title: null, dataset_id, roles: {}, options: {}, layout: { x: 0, y: 0, w: 100, h: 100 } });
const report = (dataset_id: string | null, visuals: ReturnType<typeof visual>[] = []): Report =>
  ({ id: "aaaaaaaaaaaa", name: "R", dataset_id, theme: {}, pages: [{ id: "p", name: "Page", visuals, filters: [] }], created_at: "", updated_at: "" }) as unknown as Report;

afterEach(() => useStudio.setState({ report: null }));

describe("reportDatasetId", () => {
  it("prend le jeu du rapport, sinon celui du premier visuel relié", () => {
    expect(reportDatasetId(null)).toBeUndefined();
    expect(reportDatasetId(report("ds1", [visual("ds2")]))).toBe("ds1");
    expect(reportDatasetId(report(null, [visual(null), visual("ds2")]))).toBe("ds2");
    expect(reportDatasetId(report(null))).toBeUndefined();
  });
});

describe("useStudioDatasetId", () => {
  it("suit le rapport ouvert dans le Studio, et rien hors du Studio", async () => {
    useStudio.setState({ report: report("ds1") });
    const { result, rerender } = renderHook(({ inStudio }) => useStudioDatasetId(inStudio), { initialProps: { inStudio: true } });
    await waitFor(() => expect(result.current).toBe("ds1"));

    act(() => useStudio.setState({ report: report("ds9") }));
    expect(result.current).toBe("ds9");

    rerender({ inStudio: false });
    expect(result.current).toBeUndefined();
    act(() => useStudio.setState({ report: report("ds3") }));
    expect(result.current).toBeUndefined();
  });
});
