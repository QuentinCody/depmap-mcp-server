/**
 * Co-located smoke tests for the figshare release-source helpers.
 *
 * The exhaustive suite (search-API contract, version parsing edge cases,
 * file-list filtering, error propagation) lives at:
 *
 *   tests/depmap-figshare.test.ts
 */
import { describe, expect, it } from "vitest";
import {
    parseAdultReleaseVersion,
    compareReleaseVersions,
} from "./figshare";

describe("figshare (smoke)", () => {
    it("parses canonical adult titles", () => {
        const v = parseAdultReleaseVersion("DepMap_24Q4_Public");
        expect(v).toEqual({ year: 24, quarter: 4, label: "24Q4" });
    });

    it("compares versions by year then quarter", () => {
        const a = { year: 24, quarter: 4, label: "24Q4" };
        const b = { year: 25, quarter: 1, label: "25Q1" };
        expect(compareReleaseVersions(a, b)).toBeLessThan(0);
    });
});
