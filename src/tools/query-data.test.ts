/**
 * Co-located smoke test for the depmap_query_data tool registration.
 *
 * The handler logic itself is exercised by @bio-mcp/shared's
 * createQueryDataHandler tests; this file just verifies the dual
 * registration shape (mcp_depmap_query_data + depmap_query_data).
 */
import { describe, expect, it } from "vitest";
import { registerQueryData } from "./query-data";

interface FakeMcpServer {
    registerTool: (name: string, schema: unknown, handler: unknown) => void;
}

describe("registerQueryData (smoke)", () => {
    it("registers under both the mcp_-prefixed and bare names", () => {
        const registered: string[] = [];
        const fake: FakeMcpServer = {
            registerTool: (name) => {
                registered.push(name);
            },
        };
        // The shared SDK type is a class; FakeMcpServer satisfies the only
        // member used by the registration helper.
        registerQueryData(fake as unknown as Parameters<typeof registerQueryData>[0]);
        expect(registered).toEqual([
            "mcp_depmap_query_data",
            "depmap_query_data",
        ]);
    });
});
