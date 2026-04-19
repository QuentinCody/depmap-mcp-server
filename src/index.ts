/**
 * DepMap MCP server entrypoint.
 *
 * Wires together:
 *   - The McpAgent + 7 tools (search, execute, query_data, get_schema,
 *     release_status, load_release)
 *   - The fetch handler exposing /health and /mcp
 *   - The scheduled handler that runs daily and ingests new Figshare
 *     releases for both adult and pediatric cohorts
 *
 * The two singleton DOs are addressed by well-known names:
 *   release:adult:current
 *   release:pediatric:current
 *
 * All cohort-aware code resolves the right DO instance via these names
 * — there is no per-session DO routing for staged data.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DepMapDataDO } from "./do";
import { registerQueryData } from "./tools/query-data";
import { registerGetSchema } from "./tools/get-schema";
import { registerCodeMode } from "./tools/code-mode";
import { runReleaseStatus } from "./tools/release-status";
import { runLoadRelease } from "./tools/load-release";
import {
    findLatestAdultRelease,
    getReleaseFiles,
    type FigshareFile,
} from "./lib/figshare";
import {
    loadRelease,
    type Cohort,
    type LoadReleaseInput,
    type LoadReleaseResult,
    type StageBatchFn,
} from "./lib/load-release";
import { checkAndIngestLatest } from "./lib/scheduled";
import { createMyGeneResolver } from "@bio-mcp/shared/biothings/gene-resolver";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export { DepMapDataDO };

interface DepMapEnv {
    DEPMAP_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
    DEPMAP_ADMIN_TOKEN?: string;
}

const SINGLETON_DO_NAME: Record<Cohort, string> = {
    adult: "release:adult:current",
    pediatric: "release:pediatric:current",
};

/**
 * Get the singleton DO stub for one cohort. Every cohort-aware code path
 * goes through this — there is no per-session routing for staged data.
 */
function getCohortDO(env: DepMapEnv, cohort: Cohort): DurableObjectStub {
    const id = env.DEPMAP_DATA_DO.idFromName(SINGLETON_DO_NAME[cohort]);
    return env.DEPMAP_DATA_DO.get(id);
}

/** Read the current release version label from the DO's _releases table. */
async function readCurrentVersion(
    env: DepMapEnv,
    cohort: Cohort,
): Promise<string | null> {
    const stub = getCohortDO(env, cohort);
    const response = await stub.fetch(
        new Request("http://do/query", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                sql: "SELECT version FROM _releases WHERE is_current = 1 LIMIT 1",
            }),
        }),
    );
    if (!response.ok) return null;
    const result = (await response.json()) as {
        success?: boolean;
        rows?: Array<{ version?: string }>;
    };
    if (!result.success || !result.rows || result.rows.length === 0) return null;
    return result.rows[0]?.version ?? null;
}

async function readCohortStats(
    env: DepMapEnv,
    cohort: Cohort,
): Promise<{ datasets: number; totalRows: number } | null> {
    const stub = getCohortDO(env, cohort);
    const response = await stub.fetch(new Request("http://do/schema"));
    if (!response.ok) return null;
    const result = (await response.json()) as {
        success?: boolean;
        schema?: { tables?: Array<{ name: string; row_count?: number }> };
    };
    if (!result.success || !result.schema?.tables) return null;
    const tables = result.schema.tables.filter((t) => !t.name.startsWith("_"));
    return {
        datasets: tables.length,
        totalRows: tables.reduce((s, t) => s + (t.row_count ?? 0), 0),
    };
}

/** Build a StageBatchFn bound to one cohort's singleton DO instance. */
function makeStageBatch(env: DepMapEnv, cohort: Cohort): StageBatchFn {
    return async (rows, hints) => {
        const stub = getCohortDO(env, cohort);
        const response = await stub.fetch(
            new Request("http://do/process", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    data: rows,
                    schema_hints: hints satisfies SchemaHints | undefined,
                    context: {
                        toolName: "depmap_load_release",
                        serverName: "depmap",
                    },
                }),
            }),
        );
        if (!response.ok) {
            return {
                success: false,
                rowsInserted: 0,
                error: `DO /process HTTP ${response.status}`,
            };
        }
        const result = (await response.json()) as {
            success?: boolean;
            total_rows?: number;
            error?: string;
        };
        return {
            success: Boolean(result.success),
            rowsInserted: result.total_rows ?? 0,
            error: result.error,
        };
    };
}

/** Fetch a Figshare file as a streaming body. */
async function downloadStream(
    file: FigshareFile,
): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(file.downloadUrl, {
        headers: { "user-agent": "depmap-mcp-server/1.0" },
    });
    if (!response.ok || !response.body) {
        throw new Error(
            `Figshare download failed for ${file.name}: HTTP ${response.status}`,
        );
    }
    return response.body;
}

/**
 * Run the full ingest pipeline for one release into one cohort's
 * singleton DO. Used by both the cron-driven path and the admin
 * `depmap_load_release` tool.
 */
async function runFullLoad(
    env: DepMapEnv,
    input: LoadReleaseInput,
): Promise<LoadReleaseResult> {
    return loadRelease(input, {
        getReleaseFiles: (articleId, names) =>
            getReleaseFiles(articleId, { names }).then((files) => {
                // Mismatch: getReleaseFiles only filters when names is set;
                // we already pass names so just hand back the result.
                if (names.length === 0) return files;
                return files;
            }),
        downloadStream,
        resolveGene: createMyGeneResolver(),
        stageBatch: makeStageBatch(env, input.cohort),
    });
}

function resolveEnv(env: unknown): DepMapEnv {
    if (
        env === null ||
        typeof env !== "object" ||
        !("DEPMAP_DATA_DO" in env) ||
        !("CODE_MODE_LOADER" in env)
    ) {
        throw new Error(
            "depmap-mcp-server: required wrangler bindings DEPMAP_DATA_DO and CODE_MODE_LOADER are missing.",
        );
    }
    return env as DepMapEnv;
}

export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "depmap",
        version: "0.1.0",
    });

    async init() {
        const env = resolveEnv(this.env);
        registerQueryData(this.server, env);
        registerGetSchema(this.server, env);
        registerCodeMode(this.server, env);

        // depmap_release_status — read singleton DO state.
        // The MCP SDK / classic Zod toJSONSchema breaks on empty inputSchema
        // objects — tools/list silently strips the tool. Always declare at
        // least one optional parameter even when the tool takes no input.
        const releaseStatusSchema = {
            title: "DepMap Release Status",
            description:
                "Report which DepMap release is currently ingested in each cohort " +
                "(adult and pediatric), along with table count and total row count.",
            inputSchema: {
                cohort: z
                    .enum(["adult", "pediatric"])
                    .optional()
                    .describe(
                        "Optional cohort filter; omit to receive both cohorts in the response.",
                    ),
            },
        };
        const releaseStatusHandler = async () => {
            const result = await runReleaseStatus({
                getCurrentVersion: (cohort) => readCurrentVersion(env, cohort),
                getCohortStats: (cohort) => readCohortStats(env, cohort),
            });
            // Spread into a Record<string, unknown> — the MCP SDK's
            // structuredContent slot requires an index signature, which
            // our typed `ReleaseStatusResult` interface doesn't provide
            // by design (we want strict type checking inside the server).
            const structured: Record<string, unknown> = { ...result };
            return {
                content: [
                    {
                        type: "text" as const,
                        text: result.success
                            ? `Adult: ${result.cohorts.adult.currentVersion ?? "(not loaded)"}\nPediatric: ${result.cohorts.pediatric.currentVersion ?? "(not loaded)"}`
                            : `Error: ${result.error}`,
                    },
                ],
                structuredContent: structured,
                isError: !result.success,
            };
        };
        this.server.registerTool(
            "mcp_depmap_release_status",
            releaseStatusSchema,
            releaseStatusHandler,
        );
        this.server.registerTool(
            "depmap_release_status",
            releaseStatusSchema,
            releaseStatusHandler,
        );

        // depmap_load_release — admin-gated bulk ingest.
        const loadReleaseSchema = {
            title: "Load DepMap Release (admin)",
            description:
                "Bulk-ingest one Figshare DepMap release into the singleton DO for the given cohort. " +
                "Requires an Authorization: Bearer <DEPMAP_ADMIN_TOKEN> header. " +
                "Normally invoked by the daily cron — exposed as a tool only for manual recovery.",
            inputSchema: {
                cohort: z.enum(["adult", "pediatric"]),
                version: z.string().min(1),
                articleId: z.number().int().positive(),
                doi: z.string().min(1),
            },
        };
        const loadReleaseHandler = async (
            args: Record<string, unknown>,
            extra: unknown,
        ) => {
            const input: LoadReleaseInput = {
                cohort: args.cohort as Cohort,
                version: args.version as string,
                articleId: args.articleId as number,
                doi: args.doi as string,
            };
            const request = (extra as { request?: Request })?.request;
            const authorization = request?.headers.get("authorization") ?? undefined;
            const result = await runLoadRelease(
                input,
                {
                    adminToken: env.DEPMAP_ADMIN_TOKEN,
                    runLoad: (loadInput) => runFullLoad(env, loadInput),
                },
                { authorizationHeader: authorization },
            );
            const structured: Record<string, unknown> = { ...result };
            return {
                content: [
                    {
                        type: "text" as const,
                        text: result.success
                            ? `Loaded ${result.totalRowsStaged} rows across ${result.datasets.length} datasets for ${result.cohort} ${result.version}.`
                            : `Error: ${result.error}`,
                    },
                ],
                structuredContent: structured,
                isError: !result.success,
            };
        };
        this.server.registerTool(
            "mcp_depmap_load_release",
            loadReleaseSchema,
            loadReleaseHandler,
        );
        this.server.registerTool(
            "depmap_load_release",
            loadReleaseSchema,
            loadReleaseHandler,
        );
    }
}

export default {
    fetch(request: Request, env: DepMapEnv, ctx: ExecutionContext) {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
            return new Response("ok", {
                status: 200,
                headers: { "content-type": "text/plain" },
            });
        }

        if (url.pathname === "/mcp") {
            return MyMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(
                request,
                env,
                ctx,
            );
        }

        return new Response("Not found", { status: 404 });
    },

    /**
     * Daily cron-driven ingest check. Runs for both cohorts; never throws
     * (the scheduled handler wraps every error in a result envelope).
     */
    async scheduled(event: ScheduledEvent, env: DepMapEnv, ctx: ExecutionContext) {
        const runCohort = async (cohort: Cohort) => {
            const result = await checkAndIngestLatest(cohort, {
                findLatestAdultRelease: () => findLatestAdultRelease(),
                getCurrentVersion: (c) => readCurrentVersion(env, c),
                triggerLoadRelease: (input) => runFullLoad(env, input).then(() => undefined),
            });
            console.log(
                `depmap.scheduled[${cohort}]: ${result.action}${result.version ? ` (${result.version})` : ""}${result.error ? ` ${result.error}` : ""}`,
            );
        };
        ctx.waitUntil(runCohort("adult"));
        ctx.waitUntil(runCohort("pediatric"));
        void event;
    },
};
