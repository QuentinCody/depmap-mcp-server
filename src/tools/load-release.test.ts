/**
 * Co-located smoke test for the depmap_load_release admin gate.
 *
 * Exhaustive suite (auth gate, missing token, error wrapping, delegation
 * to runLoad) at: tests/depmap-tools.test.ts
 */
import { describe, expect, it } from "vitest";
import { runLoadRelease } from "./load-release";

describe("runLoadRelease (smoke)", () => {
    it("rejects when no admin token is configured", async () => {
        const result = await runLoadRelease(
            { cohort: "adult", version: "24Q4", articleId: 1, doi: "x" },
            {
                adminToken: undefined,
                runLoad: async () => {
                    throw new Error("must not be reached");
                },
            },
            { authorizationHeader: "Bearer anything" },
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/CONFIG_ERROR/);
    });
});
