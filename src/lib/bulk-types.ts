import { z } from "zod";

export const bulkFileSchema = z.object({
  release: z.string().min(1).max(300),
  filename: z.string().min(1).max(300),
  md5: z.string().regex(/^[a-f0-9]{32}$/i),
  bytes: z.number().int().positive().max(2 * 1024 ** 3),
  role: z.enum(["model", "model_condition", "screen_sequence_map", "omics_profiles", "crispr", "omics", "prism", "other"]),
  index_column: z.number().int().positive().max(100000).optional(),
  index_type: z.enum(["ModelID", "ModelConditionID", "ScreenID", "SequencingID", "gene", "other"]).optional(),
}).strict();
export const bulkSelectionSchema = z.object({
  cohort: z.enum(["adult", "pediatric"]),
  version: z.string().min(1).max(300),
  expected_metadata_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  files: z.array(bulkFileSchema).min(1).max(12),
}).strict();
export type BulkSelection = z.infer<typeof bulkSelectionSchema>;
export type BulkFile = z.infer<typeof bulkFileSchema>;
export interface BulkManifest {
  format_version: "depmap-bulk-1";
  selection: BulkSelection;
  metadata: { url: string; sha256: string; retrieved_at: string; inventory_file_count: number; selected: Array<{ source_row_index: number; record: Record<string, string> }> };
  manifest_sha256: string;
}
export interface BulkPublication {
  data_access_id: string;
  manifest_sha256: string;
  cohort: "adult" | "pediatric";
  version: string;
  datasets: number;
  totalRows: number;
  file_sha256: string[];
  published_at: string;
}
export type BulkSql = { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[]; [Symbol.iterator](): Iterator<Record<string, unknown>> } };

export function validateSelection(raw: unknown): BulkSelection {
  const selection = bulkSelectionSchema.parse(raw);
  const identities = selection.files.map(file => JSON.stringify([file.release, file.filename]));
  if (new Set(identities).size !== identities.length) throw new Error("Select each release/file only once");
  if (selection.files.reduce((sum, file) => sum + file.bytes, 0) > 4 * 1024 ** 3) throw new Error("Selected files exceed the 4 GiB snapshot budget");
  for (const file of selection.files) {
    if (Boolean(file.index_column) !== Boolean(file.index_type)) throw new Error("Select index_column and index_type together");
    if (file.release !== selection.version && (file.role !== "prism" || file.index_type !== "ModelID")) throw new Error("Mapping/CRISPR/omics files must match the exact primary release; independent PRISM files must link by ModelID");
    file.md5 = file.md5.toLowerCase();
  }
  if (!selection.files.some(file => file.release === selection.version)) throw new Error("Select at least one file from the exact primary release");
  selection.expected_metadata_sha256 = selection.expected_metadata_sha256.toLowerCase();
  return selection;
}
