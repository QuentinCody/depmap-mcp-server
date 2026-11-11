import { hashCanonicalJson } from "@bio-mcp/shared";
import { createDepMapApiFetch } from "./api-adapter";
import { METADATA_PATH, METADATA_URL } from "./release-discovery";
import { validateSelection, type BulkManifest } from "./bulk-types";

/** Bind every selected file to one observed public inventory before accepting any bytes. */
export async function createBulkManifest(raw: unknown): Promise<BulkManifest> {
  const selection = validateSelection(raw);
  const response = await createDepMapApiFetch()({ method: "GET", path: METADATA_PATH, params: { expected_metadata_sha256: selection.expected_metadata_sha256 } });
  const inventory = response.data as { files: Record<string, string>[]; metadata_sha256: string; fetched_at: string; inventory_file_count: number };
  const selected = selection.files.map(file => {
    const matches = inventory.files.flatMap((record, index) => record.release === file.release && record.filename === file.filename ? [{ source_row_index: index, record }] : []);
    if (matches.length !== 1) throw new Error("Selected release/file is absent or ambiguous: " + file.filename);
    if (matches[0].record.md5_hash.toLowerCase() !== file.md5.toLowerCase()) throw new Error("Selected MD5 differs from the provider inventory: " + file.filename);
    return matches[0];
  });
  if (new TextEncoder().encode(JSON.stringify(selected)).byteLength > 512 * 1024) throw new Error("Selected inventory records exceed the snapshot metadata budget");
  // Retrieval time is evidence, not snapshot identity: identical selections are idempotent.
  const identity = { format_version: "depmap-bulk-1" as const, selection, metadata_sha256: inventory.metadata_sha256, selected };
  return {
    format_version: "depmap-bulk-1", selection,
    metadata: { url: METADATA_URL, sha256: inventory.metadata_sha256, retrieved_at: inventory.fetched_at, inventory_file_count: inventory.inventory_file_count, selected },
    manifest_sha256: await hashCanonicalJson(identity),
  };
}
