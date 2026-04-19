/**
 * Co-located smoke test for the singleton Durable Object.
 *
 * The DO subclasses {@link RestStagingDO} (already covered by the shared
 * package's tests) and overrides only {@link getSchemaHints}, which
 * delegates to the pure-function decider tested at:
 *
 *   tests/depmap-schema-hints.test.ts
 *
 * This file just proves the do.ts module's export shape WITHOUT pulling
 * in the `cloudflare:workers` runtime module — vitest runs in Node and
 * cannot resolve that built-in. We stub it here so the import chain
 * succeeds; the actual DO behavior is tested in deploy environment via
 * the structured-content-regression script.
 */
import { describe, expect, it, vi } from "vitest";

class DurableObjectStub {
    constructor(public ctx: unknown, public env: unknown) {}
}

vi.mock("cloudflare:workers", () => ({
    DurableObject: DurableObjectStub,
}));

describe("DepMapDataDO (smoke)", () => {
    it("exports the DO class for the wrangler binding", async () => {
        const mod = await import("./do");
        expect(typeof mod.DepMapDataDO).toBe("function");
    });
});
