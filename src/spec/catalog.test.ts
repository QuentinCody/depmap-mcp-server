/**
 * Co-located smoke test for the depmap REST catalog.
 *
 * The exhaustive structural suite (per-endpoint param/path consistency,
 * required-category coverage, REST-only methods) lives at:
 *
 *   tests/depmap-catalog.test.ts
 */
import { describe, expect, it } from "vitest";
import { depmapCatalog } from "./catalog";

describe("depmapCatalog (smoke)", () => {
    it("declares the canonical name and at least one endpoint", () => {
        expect(depmapCatalog.name).toMatch(/DepMap/);
        expect(depmapCatalog.endpoints.length).toBeGreaterThan(0);
    });

    it("endpointCount stays in sync with endpoints.length", () => {
        expect(depmapCatalog.endpointCount).toBe(depmapCatalog.endpoints.length);
    });
});
