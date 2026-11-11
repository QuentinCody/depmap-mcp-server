import { buildHealthResponse, configureCitationSigning } from "@bio-mcp/shared";
import { McpServer, StatelessMcpWorker } from "@bio-mcp/shared/mcp";
import { registerQueryData } from "./tools/query-data";
import { registerGetSchema } from "./tools/get-schema";
import { registerCodeMode } from "./tools/code-mode";
import { registerHarmonize } from "./tools/harmonize";
import { registerBulkTools } from "./tools/bulk";
import { createDepMapApiFetch } from "./lib/api-adapter";
import { METADATA_PATH } from "./lib/release-discovery";
import type { BulkEnv } from "./lib/bulk-runtime";

export { DepMapDataDO } from "./do";
interface DepMapEnv extends BulkEnv { CODE_MODE_LOADER: WorkerLoader }

export class MyMCP extends StatelessMcpWorker {
  server = new McpServer({ name: "depmap", version: "0.1.0" });
  async init() {
    configureCitationSigning(this.env);
    const env = this.env as unknown as DepMapEnv;
    if (!env.DEPMAP_DATA_DO || !env.CODE_MODE_LOADER) throw new Error("DepMap storage and Code Mode bindings are required");
    registerQueryData(this.server, env);
    registerGetSchema(this.server, env);
    registerCodeMode(this.server, env);
    registerHarmonize(this.server, env);
    registerBulkTools(this.server, env, () => this.requestContext?.requestInfo?.headers.get("authorization") ?? null);
  }
}

export default {
  fetch(request: Request, env: DepMapEnv, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return buildHealthResponse("depmap");
    if (path === "/readyz") return MyMCP.readiness(env, "depmap");
    if (path === "/mcp") return MyMCP.serve("/mcp").fetch(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
  // Observe public inventory only. A mutable latest-release guess cannot select
  // files, establish download access, or publish a checksum-verified snapshot.
  scheduled(_event: ScheduledEvent, _env: DepMapEnv, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      try {
        const { data } = await createDepMapApiFetch()({ method: "GET", path: METADATA_PATH });
        const inventory = data as { metadata_sha256: string; inventory_file_count: number };
        console.log("depmap.inventory", { observed: true, metadata_sha256: inventory.metadata_sha256, files: inventory.inventory_file_count, imported: false });
      } catch (error) { console.error("depmap.inventory", { observed: false, error: String((error as Error).message).slice(0, 300), imported: false }); }
    })());
  },
};
