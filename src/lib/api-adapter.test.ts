/**
 * Co-located smoke test for the depmap REST → ApiFetchFn adapter.
 *
 * The exhaustive suite (query-param building, JSON vs text content type,
 * non-2xx error attachment, GET-only enforcement) lives at:
 *
 *   tests/depmap-api-adapter.test.ts
 */
import { describe, expect, it } from "vitest";
import { createDepMapApiFetch } from "./api-adapter";

describe("createDepMapApiFetch (smoke)", () => {
    it("issues GET against baseUrl + path", async () => {
        const captured: { url: string }[] = [];
        const fetchImpl: typeof fetch = async (input) => {
            captured.push({
                url: typeof input === "string" ? input : input.toString(),
            });
            return new Response("[]", {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        };
        const apiFetch = createDepMapApiFetch({ fetch: fetchImpl });
        const result = await apiFetch({ method: "GET", path: "/genes" });
        expect(result.status).toBe(200);
        expect(captured[0].url).toBe("https://depmap.org/portal/api/genes");
    });
});
