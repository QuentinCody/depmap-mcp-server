/**
 * `depmap_get_schema` — list tables in staged data or a sealed snapshot,
 * with row counts, columns, and inferred indexes/relationships.
 *
 * Thin wrapper over the shared {@link createGetSchemaHandler}.
 */
import type { McpServer } from "@bio-mcp/shared/mcp";
import { z } from "zod";
import { createGetSchemaHandler } from "@bio-mcp/shared/staging/utils";
import { resolveBulkArgs } from "../lib/bulk-runtime";
import { commercialHandleError } from "../lib/commercial-profile";
import { depmapResponse } from "../lib/tool-result";

interface SchemaEnv {
    DEPMAP_DATA_DO?: unknown;
}

export function registerGetSchema(server: McpServer, env?: SchemaEnv): void {
    const handler = createGetSchemaHandler("DEPMAP_DATA_DO", "depmap");

    const schema = {
        title: "Get DepMap Staged Schema",
        description:
            "Inspect the schema of staged DepMap data (tables, columns, row counts, indexes). " +
            "Use to discover which release versions are loaded and which dataset tables exist " +
            "before writing a depmap_query_data SQL query. " +
            "Pass a returned staging/snapshot handle, or 'adult:current' / 'pediatric:current' for a verified publication. " +
            "For imported CSV layouts, inspect depmap_files.columns_json and source_json; generic SQLite table columns are not native file headers.",
        inputSchema: {
            data_access_id: z
                .string()
                .min(1)
                .describe(
                    "Returned staging/snapshot handle, verified 'adult:current' / 'pediatric:current', or explicit legacy 'release:adult:current' handle.",
                ),
        },
    } as const;

    const handlerWrapper = async (
        args: Record<string, unknown>,
        extra: { env?: SchemaEnv },
    ) => {
        const runtimeEnv = env || extra?.env || {};
        // Pass the full extra (not just sessionId) so the handler resolves the same
        // request scope the execute/staging path registers under (getRequestScope:
        // _meta["dev.quentincody.bio/chatId"] / mcp-chat-id header, then sessionId).
        // A reselling caller cannot open imported release files (see lib/commercial-profile).
        return depmapResponse(async () => commercialHandleError(args.data_access_id, extra)
            ?? handler(await resolveBulkArgs(args, runtimeEnv), runtimeEnv as Record<string, unknown>, extra as Record<string, unknown>), runtimeEnv, "depmap_get_schema", extra, args);
    };

    const reg = (name: string) =>
        server.registerTool(name, schema, async (args, extra) =>
            handlerWrapper(
                args as Record<string, unknown>,
                extra as { env?: SchemaEnv },
            ),
        );
    reg("mcp_depmap_get_schema");
    reg("depmap_get_schema");
}
