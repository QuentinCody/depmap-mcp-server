/**
 * Co-located smoke test for the depmap Code Mode tool registration.
 *
 * The shared `createSearchTool` / `createExecuteTool` factories are
 * fully tested in @bio-mcp/shared. Here we just prove that
 * registerCodeMode wires up the depmap-prefixed `_search` and
 * `_execute` tools onto a fake McpServer.
 */
import { describe, expect, it, vi } from "vitest";

class DurableObjectStub {
    constructor(public ctx: unknown, public env: unknown) {}
}
class RpcTargetStub {}

vi.mock("cloudflare:workers", () => ({
    DurableObject: DurableObjectStub,
    RpcTarget: RpcTargetStub,
}));

const { registerCodeMode } = await import("./code-mode");

interface FakeMcpServer {
    readonly tool: (...args: unknown[]) => void;
    readonly registerTool: (...args: unknown[]) => void;
}

describe("registerCodeMode (smoke)", () => {
    it("registers depmap_search and depmap_execute on the McpServer", () => {
        const registered: string[] = [];
        const fake: FakeMcpServer = {
            tool: (name) => {
                registered.push(String(name));
            },
            registerTool: (name) => {
                registered.push(String(name));
            },
        };
        // Real bindings live on the wrangler `env` at runtime — at
        // registration time the factories only need any non-null
        // reference to validate. No isolate is created here.
        const env = {
            DEPMAP_DATA_DO: {} as DurableObjectNamespace,
            // Validates as WorkerLoaderBinding via the .get duck-type check.
            CODE_MODE_LOADER: { get: () => undefined } as unknown as WorkerLoader,
        };
        registerCodeMode(
            fake as unknown as Parameters<typeof registerCodeMode>[0],
            env,
        );
        expect(registered).toEqual(
            expect.arrayContaining(["depmap_search", "depmap_execute"]),
        );
    });
});
