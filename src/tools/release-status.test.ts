/**
 * Co-located smoke test for runReleaseStatus.
 *
 * Exhaustive suite at: tests/depmap-tools.test.ts
 */
import { describe, expect, it } from "vitest";
import { runReleaseStatus } from "./release-status";

describe("runReleaseStatus (smoke)", () => {
    it("reports the current version for both cohorts", async () => {
        const result = await runReleaseStatus({
            getCurrentVersion: async (c) => (c === "adult" ? "24Q4" : null),
            getCohortStats: async () => null,
        });
        expect(result.success).toBe(true);
        expect(result.cohorts.adult.currentVersion).toBe("24Q4");
        expect(result.cohorts.pediatric.currentVersion).toBeNull();
    });
});
