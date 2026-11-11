/**
 * `depmap_query_data` — execute SQL against staged responses or sealed CSV snapshots.
 *
 * Thin wrapper over the shared {@link createQueryDataHandler}.
 *
 * Cohort aliases resolve to verified publications; ordinary staged handles
 * retain their own Durable Object routing.
 */
import type { McpServer } from "@bio-mcp/shared/mcp";
import { z } from "zod";
import { createQueryDataHandler } from "@bio-mcp/shared/staging/utils";
import { resolveBulkArgs } from "../lib/bulk-runtime";
import { commercialHandleError } from "../lib/commercial-profile";
import { depmapResponse } from "../lib/tool-result";

interface QueryEnv {
    DEPMAP_DATA_DO?: unknown;
}

export function registerQueryData(server: McpServer, env?: QueryEnv): void {
    const handler = createQueryDataHandler("DEPMAP_DATA_DO", "depmap");

    const schema = {
        title: "Query Staged DepMap Data",
        description:
            "Query staged responses or verified selected-file snapshots via read-only SQL. " +
            "Bulk snapshots expose depmap_files (ordered columns_json, pins and checksums), depmap_rows " +
            "(file_index, one-based record_index, optional literal index_value, string cells_json) and depmap_chunks (original base64 bytes). " +
            "No implicit pivot, numeric coercion or biological identity resolution. Inspect depmap_get_schema first; " +
            "adult:current and pediatric:current resolve only completely verified publications.",
        inputSchema: {
            data_access_id: z
                .string()
                .min(1)
                .describe(
                    "Returned staging/snapshot handle, verified 'adult:current' / 'pediatric:current', or explicit legacy 'release:adult:current' handle.",
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
                .optional()
                .describe("Maximum number of rows to return (default: 100)"),
        },
    } as const;

    const handlerWrapper = async (
        args: Record<string, unknown>,
        extra: { env?: QueryEnv },
    ) => {
        const runtimeEnv = env || extra?.env || {};
        // A reselling caller cannot read imported release files (see lib/commercial-profile).
        // The check runs before the alias lookup, so it opens no store.
        return depmapResponse(async () => commercialHandleError(args.data_access_id, extra)
            ?? handler(await resolveBulkArgs(args, runtimeEnv), runtimeEnv as Record<string, unknown>), runtimeEnv, "depmap_query_data", extra, args);
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
