/**
 * Co-located smoke test for the scheduled handler.
 *
 * The exhaustive suite (no-release / up-to-date / load-triggered /
 * cohort routing / error wrapping) lives at:
 *
 *   tests/depmap-scheduled.test.ts
 */
import { describe, expect, it } from "vitest";
import { checkAndIngestLatest } from "./scheduled";

describe("checkAndIngestLatest (smoke)", () => {
    it("returns no_release_found when Figshare has nothing", async () => {
        const result = await checkAndIngestLatest("adult", {
            findLatestAdultRelease: async () => null,
            getCurrentVersion: async () => null,
            triggerLoadRelease: async () => {},
        });
        expect(result.action).toBe("no_release_found");
    });
});
