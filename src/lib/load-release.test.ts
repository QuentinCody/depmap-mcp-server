/**
 * Co-located smoke test for the load-release orchestrator.
 *
 * The exhaustive suite (matrix vs dimension routing, multi-dataset
 * batching, per-dataset error isolation, resolver wiring) lives at:
 *
 *   tests/depmap-load-release.test.ts
 */
import { describe, expect, it } from "vitest";
import { RELEASE_DATASETS } from "./load-release";

describe("RELEASE_DATASETS (smoke)", () => {
    it("includes a sample_info dimension dataset", () => {
        const sampleInfo = RELEASE_DATASETS.find((d) => d.name === "sample_info");
        expect(sampleInfo?.kind).toBe("dimension");
        expect(sampleInfo?.dimensionTableName).toBe("sample_info");
    });

    it("includes at least one matrix dataset (gene_effect)", () => {
        const ge = RELEASE_DATASETS.find((d) => d.name === "gene_effect");
        expect(ge?.kind).toBe("matrix");
    });
});
