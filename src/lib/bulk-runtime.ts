import { createBulkManifest } from "./bulk-manifest";
import type { BulkManifest, BulkPublication } from "./bulk-types";

export interface BulkEnv { DEPMAP_DATA_DO: DurableObjectNamespace; DEPMAP_ADMIN_TOKEN?: string }
type SnapshotStatus = { phase?: string; data_access_id?: string; expected_current?: string | null; manifest?: BulkManifest; files?: Array<{ rows: number; sha256: string }> };

export async function bulkCall(env: Pick<BulkEnv, "DEPMAP_DATA_DO">, id: string, path: string, body?: unknown) {
  const stub = env.DEPMAP_DATA_DO.get(env.DEPMAP_DATA_DO.idFromName(id));
  const response = await stub.fetch(new Request("http://do" + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const result = await response.json() as { success?: boolean; error?: string; data?: unknown; current?: BulkPublication | null } & SnapshotStatus;
  if (!response.ok || result.success !== true) throw new Error(result.error ?? "DepMap snapshot storage failed");
  return result;
}
export async function currentPublication(env: Pick<BulkEnv, "DEPMAP_DATA_DO">, cohort: "adult" | "pediatric") {
  return (await bulkCall(env, "release:" + cohort + ":current", "/bulk/current")).current ?? null;
}
export async function resolveBulkArgs(args: Record<string, unknown>, env: { DEPMAP_DATA_DO?: unknown }) {
  const match = /^(adult|pediatric):current$/.exec(String(args.data_access_id));
  if (!match || !env.DEPMAP_DATA_DO) return args;
  const current = await currentPublication(env as BulkEnv, match[1] as "adult" | "pediatric");
  // Existing unversioned data is not promoted to a verified current snapshot.
  if (!current) throw new Error("No completely verified snapshot is published for this cohort; use an explicit legacy or staging handle");
  return { ...args, data_access_id: current.data_access_id };
}
export async function runBulkImport(args: Record<string, unknown>, env: BulkEnv, authorization: string | null) {
  if (!env.DEPMAP_ADMIN_TOKEN || authorization !== "Bearer " + env.DEPMAP_ADMIN_TOKEN) throw new Error("AUTH_ERROR: a configured DepMap admin Bearer token is required");
  if (args.action === "begin") {
return await beginBulkImport(args, env);
  }
  const id = args.data_access_id;
  if (typeof id !== "string" || !/^depmap_bulk_(adult|pediatric)_[a-f0-9-]{36}$/.test(id)) throw new Error("Use the exact bulk data_access_id returned by begin");
  if (args.action === "status") return bulkCall(env, id, "/bulk/status");
  if (args.action === "append") return (await bulkCall(env, id, "/bulk/append", { file_index: args.file_index, chunk_index: args.chunk_index, data_base64: args.data_base64 })).data;
  if (args.action === "verify") return (await bulkCall(env, id, "/bulk/verify", { file_index: args.file_index })).data;
  if (args.action === "abort") return (await bulkCall(env, id, "/bulk/abort", {})).data;
  if (args.action !== "publish") throw new Error("Choose begin, status, append, verify, publish or abort; legacy automatic filename ingestion is retired");
  const sealed = (await bulkCall(env, id, "/bulk/seal", {})).data as SnapshotStatus;
  if (sealed.phase !== "sealed" || !sealed.manifest || !sealed.files) throw new Error("Snapshot could not be verified");
  const selection = sealed.manifest.selection;
  const publication: BulkPublication = {
    data_access_id: id, manifest_sha256: sealed.manifest.manifest_sha256, cohort: selection.cohort,
    version: selection.version, datasets: selection.files.length, totalRows: sealed.files.reduce((sum, file) => sum + file.rows, 0), file_sha256: sealed.files.map(file => file.sha256), published_at: new Date().toISOString(),
  };
  const expectedCurrent = typeof args.expected_current === "string" ? args.expected_current : sealed.expected_current ?? null;
  return (await bulkCall(env, "release:" + selection.cohort + ":current", "/bulk/publish", { publication, expected_current: expectedCurrent })).data;
}

async function beginBulkImport(args: Record<string, unknown>, env: BulkEnv) {
    if (typeof args.request_id !== "string" || !/^[a-f0-9-]{36}$/i.test(args.request_id)) throw new Error("Use an explicit UUID request_id, retained for begin retries");
    const manifest = await createBulkManifest(args.selection);
    const cohort = manifest.selection.cohort;
    const current = await currentPublication(env, cohort);
    if (current?.manifest_sha256 === manifest.manifest_sha256) return { phase: "published", current, reused: true };
    const id = "depmap_bulk_" + cohort + "_" + args.request_id.toLowerCase();
    const existing = await bulkCall(env, id, "/bulk/status");
    if (existing.manifest) {
      if (existing.manifest.manifest_sha256 !== manifest.manifest_sha256) throw new Error("request_id already belongs to a different manifest");
      return existing;
    }
    return (await bulkCall(env, id, "/bulk/begin", { manifest, data_access_id: id, expected_current: current?.data_access_id ?? null })).data;

}
