/**
 * `depmap_get_schema` — list the staged tables in the singleton DO,
 * with row counts, columns, and inferred indexes/relationships.
 *
 * Thin wrapper over the shared {@link createGetSchemaHandler}.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGetSchemaHandler } from "@bio-mcp/shared/staging/utils";

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
            "(e.g. gene_effect_24Q4, sample_info) before writing a depmap_query_data SQL query. " +
            "Pass data_access_id='adult:current' or 'pediatric:current' to select the cohort.",
        inputSchema: {
            data_access_id: z
                .string()
                .min(1)
                .describe(
                    "Cohort tag — 'adult:current' or 'pediatric:current'.",
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
        return handler(args, runtimeEnv as Record<string, unknown>, extra as Record<string, unknown>);
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
