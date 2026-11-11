import type { McpServer } from "@bio-mcp/shared/mcp";
import { createCodeModeError, createCodeModeResponse } from "@bio-mcp/shared/codemode/response";
import { z } from "zod";
import { bulkSelectionSchema } from "../lib/bulk-types";
import { currentPublication, runBulkImport, type BulkEnv } from "../lib/bulk-runtime";
import { depmapResponse } from "../lib/tool-result";

export function registerBulkTools(server: McpServer, env: BulkEnv, authorization: () => string | null) {
  const loadSchema = {
    title: "Import selected DepMap files (admin)",
    description: "Resumable, checksum-verified CSV import. Begin with exact public-inventory release/file/MD5 pins and a retained UUID; upload obtained file bytes as sequential 48KiB base64 chunks, verify each complete file, then publish the selected snapshot atomically. Keeps original bytes/cells and duplicate headers/rows. Existing current data stays available until publication. Does not download files or infer a latest release. Requires the configured admin Bearer header.",
    inputSchema: {
      action: z.enum(["begin", "status", "append", "verify", "publish", "abort"]),
      selection: bulkSelectionSchema.optional(),
      request_id: z.string().uuid().optional(),
      data_access_id: z.string().min(1).max(120).optional(),
      expected_current: z.string().regex(/^depmap_bulk_(adult|pediatric)_[a-f0-9-]{36}$/).optional().describe("Publish only: explicitly selected current snapshot after a publication conflict; otherwise retains the begin-time comparison"),
      file_index: z.number().int().nonnegative().max(11).optional(),
      chunk_index: z.number().int().nonnegative().optional(),
      data_base64: z.string().max(65536).optional(),
    },
  };
  for (const name of ["depmap_load_release", "mcp_depmap_load_release"]) {
    server.registerTool(name, loadSchema, (args, extra) => depmapResponse(async () => {
      try { return createCodeModeResponse(await runBulkImport(args, env, authorization())); }
      catch (error) { return createCodeModeError("IMPORT_ERROR", String((error as Error).message).slice(0, 2000)); }
    }, env, name, extra, args));
  }
  const statusSchema = {
    title: "DepMap published snapshot status",
    description: "Report only completely verified, atomically published file selections for the requested cohort. Counts describe selected CSV records, not pivoted measurements or whole-release completeness. Legacy tables without a verified publication are not current snapshots.",
    inputSchema: { cohort: z.enum(["adult", "pediatric"]).optional() },
  };
  for (const name of ["depmap_release_status", "mcp_depmap_release_status"]) {
    server.registerTool(name, statusSchema, (args, extra) => depmapResponse(async () => {
      const cohorts: Record<string, unknown> = {};
      for (const cohort of args.cohort ? [args.cohort] : ["adult", "pediatric"] as const) {
        const current = await currentPublication(env, cohort);
        cohorts[cohort] = { currentVersion: current?.version ?? null, stats: current ? { datasets: current.datasets, totalRows: current.totalRows } : null, publication: current };
      }
      return createCodeModeResponse({ success: true, cohorts, scope: "Published selected files only; no latest-release inference or complete-release coverage." });
    }, env, name, extra, args));
  }
}
