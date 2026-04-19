/**
 * `depmap_query_data` — execute SQL against the singleton DO's staged
 * tables (long-form measurement matrices + sample_info dimension).
 *
 * Thin wrapper over the shared {@link createQueryDataHandler}.
 *
 * Note: depmap routes EVERY query against the singleton DO, regardless
 * of `data_access_id`. The `data_access_id` argument here is preserved
 * for shared-handler compatibility but in practice will be the version
 * label (e.g. "24Q4") that callers can pin queries to. The actual table
 * routing is encoded in the SQL via the table name (e.g. "gene_effect_24Q4").
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createQueryDataHandler } from "@bio-mcp/shared/staging/utils";

interface QueryEnv {
    DEPMAP_DATA_DO?: unknown;
}

export function registerQueryData(server: McpServer, env?: QueryEnv): void {
    const handler = createQueryDataHandler("DEPMAP_DATA_DO", "depmap");

    const schema = {
        title: "Query Staged DepMap Data",
        description:
            "Query staged DepMap (Cancer Dependency Map) bulk data via SQL against the singleton Durable Object. " +
            "Long-form tables: <dataset>_<version> (e.g. gene_effect_24Q4) with columns " +
            "{entrez_id, gene_symbol, cell_line_id, value, version, dataset}. " +
            "Dimension table: sample_info with {depmap_id, lineage, primary_disease, ...}. " +
            "Use depmap_get_schema to discover available tables and the current release version.",
        inputSchema: {
            data_access_id: z
                .string()
                .min(1)
                .describe(
                    "Cohort tag — 'adult:current' or 'pediatric:current'. Routes the query to the matching singleton DO instance.",
                ),
            sql: z
                .string()
                .min(1)
                .describe("SQL query to execute against the staged data"),
            limit: z
                .number()
                .int()
                .positive()
                .max(10000)
                .default(100)
                .optional()
                .describe("Maximum number of rows to return (default: 100)"),
        },
    } as const;

    const handlerWrapper = async (
        args: Record<string, unknown>,
        extra: { env?: QueryEnv },
    ) => {
        const runtimeEnv = env || extra?.env || {};
        return handler(args, runtimeEnv as Record<string, unknown>);
    };

    const reg = (name: string) =>
        server.registerTool(name, schema, async (args, extra) =>
            handlerWrapper(
                args as Record<string, unknown>,
                extra as { env?: QueryEnv },
            ),
        );
    reg("mcp_depmap_query_data");
    reg("depmap_query_data");
}
