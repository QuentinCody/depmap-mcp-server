import type { McpServer } from "@bio-mcp/shared/mcp";
import { buildPassthroughCitation } from "@bio-mcp/shared";
import { createCodeModeResponse, createCodeModeError } from "@bio-mcp/shared/codemode/response";
import { shouldStage, stageToDoAndRespond } from "@bio-mcp/shared/staging/utils";
import { harmonize, harmonizeSchema } from "../lib/harmonize";
import { depmapResponse } from "../lib/tool-result";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export interface HarmonizeEnv { DEPMAP_DATA_DO?: DurableObjectNamespace }

export async function runHarmonize(args: Record<string, unknown>, env: HarmonizeEnv, extra?: Record<string, unknown>) {
  try {
    const result = await harmonize(args);
    let payload: Record<string, unknown> = result;
    let dataAccessId: string | undefined;
    if (shouldStage(bytes(result))) {
      if (!env.DEPMAP_DATA_DO) throw new Error("Harmonization result requires DEPMAP_DATA_DO staging; reduce the subset");
      const staged = await stageToDoAndRespond(result, env.DEPMAP_DATA_DO, "depmap_harmonize", undefined, { toolName: "depmap_harmonize", serverName: "depmap" }, "depmap", extra);
      dataAccessId = staged.dataAccessId;
      payload = {
        staged: true, data_access_id: dataAccessId, _staging: staged._staging,
        mapping_release: result.mapping_release, supplied_subset_sha256: result.supplied_subset_sha256,
        row_count: result.row_count, matched_rows: result.matched_rows, unmatched_rows: result.unmatched_rows,
        complete: result.complete, completeness_scope: result.completeness_scope,
        provenance: result.provenance, notes: result.notes,
      };
    }
    const meta = await buildPassthroughCitation({ source: { id: "depmap", name: "DepMap supplied subset harmonization", url: "https://depmap.org/portal/data_page/", license: "Per-file provider terms" }, server: "depmap", tool: "depmap_harmonize", query: { supplied_subset_sha256: result.supplied_subset_sha256 }, result, dataAccessId });
    const response = createCodeModeResponse(payload, { meta });
    const structuredContent = { ...response.structuredContent, ...(payload._staging ? { _staging: payload._staging } : {}) };
    if (bytes(structuredContent) > 100_000) throw new Error("Harmonization metadata exceeds the transport limit");
    return { ...response, structuredContent };
  } catch (error) {
    return createCodeModeError("HARMONIZATION_ERROR", (error instanceof Error ? error.message : String(error)).slice(0, 2000));
  }
}

export function registerHarmonize(server: McpServer, env: HarmonizeEnv) {
  const config = {
    title: "Join pinned DepMap subsets by model identity",
    description: "Associate supplied CRISPR, omics and PRISM row subsets using exact ModelID and release-matched condition/screen/sequencing crosswalks. All source rows retained; unmatched rows reported. Up to 5000 total rows and 1MB input. Caller supplies release, filename and original file MD5; these pins are declared, not verified against downloaded bytes. PRISM may pin an independent release. Does not download files or infer equivalent conditions, genes or drugs.",
    inputSchema: harmonizeSchema.shape,
  };
  for (const name of ["depmap_harmonize", "mcp_depmap_harmonize"]) {
    server.registerTool(name, config, (args, extra) => depmapResponse(() => runHarmonize(args, env, extra as Record<string, unknown>), env, name, extra, args));
  }
}
