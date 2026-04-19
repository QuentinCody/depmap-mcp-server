/**
 * Co-located smoke test for the depmap_get_schema tool registration.
 * Handler logic is exercised by @bio-mcp/shared's createGetSchemaHandler tests.
 */
import { describe, expect, it } from "vitest";
import { registerGetSchema } from "./get-schema";

interface FakeMcpServer {
    registerTool: (name: string, schema: unknown, handler: unknown) => void;
}

describe("registerGetSchema (smoke)", () => {
    it("registers under both the mcp_-prefixed and bare names", () => {
        const registered: string[] = [];
        const fake: FakeMcpServer = {
            registerTool: (name) => {
                registered.push(name);
            },
        };
        registerGetSchema(
            fake as unknown as Parameters<typeof registerGetSchema>[0],
        );
        expect(registered).toEqual([
            "mcp_depmap_get_schema",
            "depmap_get_schema",
        ]);
    });
});
