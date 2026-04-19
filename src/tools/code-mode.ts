/**
 * `depmap_search` + `depmap_execute` — Code Mode tools for the DepMap
 * REST API.
 *
 *   depmap_search  : in-process catalog query (no isolate)
 *   depmap_execute : V8 isolate with api.get / api.post calling the
 *                    DepMap portal REST surface
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { depmapCatalog } from "../spec/catalog";
import { createDepMapApiFetch } from "../lib/api-adapter";

interface CodeModeEnv {
    DEPMAP_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

interface LegacyToolHost {
    readonly tool: (...args: unknown[]) => void;
}

function hasLegacyToolMethod(server: McpServer): server is McpServer & LegacyToolHost {
    const candidate = server as { readonly tool?: unknown };
    return typeof candidate.tool === "function";
}

/**
 * The shared codemode helpers' `register` accept the McpServer's older
 * `.tool(name, schema, handler)` API. McpServer still ships this method
 * in 1.26.0 even though `registerTool` is the documented surface. The
 * type guard makes the bridge explicit instead of an opaque cast.
 */
function asLegacyToolHost(server: McpServer): LegacyToolHost {
    if (!hasLegacyToolMethod(server)) {
        throw new Error(
            "Incompatible MCP SDK: McpServer.tool() method is required by Code Mode shared helpers.",
        );
    }
    return server;
}

export function registerCodeMode(server: McpServer, env: CodeModeEnv): void {
    const apiFetch = createDepMapApiFetch();
    const host = asLegacyToolHost(server);

    const searchTool = createSearchTool({
        prefix: "depmap",
        catalog: depmapCatalog,
    });
    searchTool.register(host);

    const executeTool = createExecuteTool({
        prefix: "depmap",
        catalog: depmapCatalog,
        apiFetch,
        doNamespace: env.DEPMAP_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(host);
}
