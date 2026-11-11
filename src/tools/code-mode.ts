/**
 * `depmap_search` + `depmap_execute` — Code Mode tools for the DepMap
 * REST API.
 *
 *   depmap_search  : in-process catalog query (no isolate)
 *   depmap_execute : V8 isolate with api.get / api.post calling the
 *                    DepMap portal REST surface
 */
import { getRequestLicenseProfile, type MaybeExtra } from "@bio-mcp/shared";
import type { McpServer } from "@bio-mcp/shared/mcp";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { depmapCatalog } from "../spec/catalog";
import { createDepMapApiFetch } from "../lib/api-adapter";
import { commercialDataNamespace } from "../lib/commercial-profile";
import { depmapResponse } from "../lib/tool-result";

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
    const dualHost = { tool: (...args: unknown[]) => {
        const [name, ...rest] = args;
        const handler = rest.pop() as (args: unknown, extra: unknown) => ReturnType<Parameters<typeof depmapResponse>[0]>;
        rest.push((args: unknown, extra: unknown) => depmapResponse(() => handler(args, extra), env, String(name), extra, args));
        host.tool(name, ...rest);
        host.tool(`mcp_${String(name)}`, ...rest);
    } };

    const searchTool = createSearchTool({
        prefix: "depmap",
        catalog: depmapCatalog,
    });
    searchTool.register(dualHost);

    const executeOptions = {
        prefix: "depmap",
        // Verifiable provenance: depmap_execute results carry a _meta.citation.
        source: { id: "depmap", name: "DepMap (Cancer Dependency Map)", url: "https://depmap.org", license: "Per-file DepMap/provider terms; see selected release" },
        catalog: depmapCatalog,
        apiFetch,
        maxInlineBytes: 30 * 1024,
        stagingThreshold: 30 * 1024,
        preserveApiErrors: true,
        loader: env.CODE_MODE_LOADER,
    };
    const executeTool = createExecuteTool({ ...executeOptions, doNamespace: env.DEPMAP_DATA_DO });
    // A reselling caller runs the same tool over a namespace that refuses the
    // stores of imported release files: api.query() and db.queryStaged() open a
    // store by name, without the API adapter (see lib/commercial-profile).
    const commercialExecute = executeHandler(
        createExecuteTool({ ...executeOptions, doNamespace: commercialDataNamespace(env.DEPMAP_DATA_DO) }),
    );
    executeTool.register({ tool: (...args: unknown[]) => {
        const execute = args.pop() as ExecuteHandler;
        dualHost.tool(...args, (input: unknown, extra: unknown) =>
            (getRequestLicenseProfile(extra as MaybeExtra | undefined) === "commercial" ? commercialExecute : execute)(input, extra));
    } });
}

type ExecuteHandler = (input: unknown, extra: unknown) => ReturnType<Parameters<typeof depmapResponse>[0]>;

/** The handler that an execute tool gives to `server.tool()`. */
function executeHandler(tool: { register: (host: LegacyToolHost) => void }): ExecuteHandler {
    let handler: ExecuteHandler | undefined;
    tool.register({ tool: (...args: unknown[]) => { handler = args[args.length - 1] as ExecuteHandler; } });
    if (!handler) throw new Error("The Code Mode execute tool registered no handler.");
    return handler;
}
