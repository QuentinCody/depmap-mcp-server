import { z } from "zod";
import { sha256 } from "./release-discovery";

const rowSchema = z.record(z.string(), z.unknown());
const fileSchema = z.object({
  release: z.string().min(1).max(200), filename: z.string().min(1).max(200),
  md5_hash: z.string().regex(/^[a-f\d]{32}$/i),
  rows: z.array(rowSchema).max(5000),
}).strict();
const axisSchema = z.enum(["ModelID", "ModelConditionID", "ScreenID", "SequencingID"]);
export const harmonizeSchema = z.object({
  model: fileSchema,
  model_condition: fileSchema.optional(),
  screen_sequence_map: fileSchema.optional(),
  omics_profiles: fileSchema.optional(),
  datasets: z.array(fileSchema.extend({
    kind: z.enum(["crispr", "omics", "prism"]),
    index_type: axisSchema,
    index_column: z.string().min(1).max(200),
  })).min(1).max(12),
}).strict();

type Row = Record<string, unknown>;
type Axis = z.infer<typeof axisSchema>;
type Input = z.infer<typeof harmonizeSchema>;
type Mapping = { model: string; condition?: string; refs: number[] };

function identifier(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim() !== value) throw new Error(`${column} must be an exact string identifier`);
  return value;
}

function crosswalk(file: Input["model_condition"], axis: Axis): Map<string, Mapping> {
  const map = new Map<string, Mapping>();
  file?.rows.forEach((row, index) => {
    const key = identifier(row, axis);
    const model = identifier(row, "ModelID");
    const condition = identifier(row, "ModelConditionID");
    if (!key || !model) throw new Error(`${file.filename} row ${index} requires ${axis} and ModelID`);
    const previous = map.get(key);
    if (previous && (previous.model !== model || previous.condition !== condition)) throw new Error(`Ambiguous ${axis} mapping for ${key}`);
    if (previous) previous.refs.push(index);
    else map.set(key, { model, condition, refs: [index] });
  });
  return map;
}

/** Exact-ID links across supplied subsets, preserving measurements and all map rows. */
export async function harmonize(raw: unknown) {
  const { input, maps, models, files, serialized } = prepareHarmonization(raw);
  const links = input.datasets.flatMap((file, sourceIndex) => file.rows.map((row, rowIndex) => {
    const key = identifier(row, file.index_column);
    const canonicalKey = identifier(row, file.index_type);
    if (key && canonicalKey && key !== canonicalKey) throw new Error(`Conflicting ${file.index_type} index in dataset ${sourceIndex}, row ${rowIndex}`);
    const mapping = key && file.index_type !== "ModelID" ? maps[file.index_type].get(key) : undefined;
    const model = file.index_type === "ModelID" ? key : mapping?.model;
    const directModel = identifier(row, "ModelID");
    const directCondition = identifier(row, "ModelConditionID");
    if (model && directModel && model !== directModel) throw new Error(`Conflicting ModelID in dataset ${sourceIndex}, row ${rowIndex}`);
    if (mapping?.condition && directCondition && mapping.condition !== directCondition) throw new Error(`Conflicting ModelConditionID in dataset ${sourceIndex}, row ${rowIndex}`);
    const condition = mapping?.condition ?? directCondition;
    const conditionMapping = condition ? maps.ModelConditionID.get(condition) : undefined;
    if (model && conditionMapping && model !== conditionMapping.model) throw new Error(`Condition maps to a different model in dataset ${sourceIndex}, row ${rowIndex}`);
    const modelIndex = model ? models.get(model) : undefined;
    return {
      dataset_index: sourceIndex, row_index: rowIndex, index_type: file.index_type, index_value: key ?? null,
      model_id: model ?? null, model_row_index: modelIndex ?? null,
      model_condition_id: condition ?? null, mapping_row_indices: mapping?.refs ?? [],
      condition_row_indices: conditionMapping?.refs ?? [],
      status: !key ? "missing_index" : !model ? "unmapped_index" : modelIndex === undefined ? "missing_model" : "matched",
    };
  }));
  const unmatched = links.filter(link => link.status !== "matched").length;
  return {
    inputs: input, links,
    observed_schemas: files.map(file => ({ release: file.release, filename: file.filename, columns: [...new Set(file.rows.flatMap(row => Object.keys(row)))], row_count: file.rows.length, scope: "supplied subset only" })),
    supplied_subset_sha256: await sha256(serialized),
    mapping_release: input.model.release,
    row_count: links.length, matched_rows: links.length - unmatched, unmatched_rows: unmatched,
    complete: unmatched === 0, completeness_scope: "model links for supplied rows only; not whole-file or whole-release coverage",
    provenance: "Caller-supplied release/filename/MD5 pins; original file bytes and provider checksums have not been verified. Subset SHA-256 fingerprints the JSON input only.",
    notes: "Model-level association only. No aggregation, common-condition inference, gene/drug equivalence, name matching, or implicit IsDefaultEntryForModel/IsDefaultEntryForMC filtering. All source records and mapping rows retained. Independently versioned PRISM sources keep their own release pins.",
  };
}

function prepareHarmonization(raw: unknown) {
  const serialized = JSON.stringify(raw);
  if (!serialized || new TextEncoder().encode(serialized).byteLength > 1000000) throw new Error("Harmonization input exceeds 1MB; submit a smaller subset");
  const input = harmonizeSchema.parse(raw);
  const mappingFiles = [input.model, input.model_condition, input.screen_sequence_map, input.omics_profiles].filter(f => f !== undefined);
  const files = [...mappingFiles, ...input.datasets];
  if (files.reduce((sum, file) => sum + file.rows.length, 0) > 5000) throw new Error("Harmonization supports at most 5000 total supplied rows");
  if (mappingFiles.some(file => file.release !== input.model.release)) throw new Error("All mapping files must pin the same DepMap release as Model.csv");
  if (input.datasets.some(file => file.kind !== "prism" && file.release !== input.model.release)) throw new Error("CRISPR and omics files must pin the mapping release; independent PRISM releases remain explicit");
  if (input.datasets.some(file => file.release !== input.model.release && file.index_type !== "ModelID")) throw new Error("An independent PRISM release must link by ModelID; release-specific crosswalks cannot be borrowed from another release");
  const models = new Map<string, number>();
  input.model.rows.forEach((row, index) => {
    const id = identifier(row, "ModelID");
    if (!id || models.has(id)) throw new Error("Model metadata requires unique, nonempty ModelID values");
    models.set(id, index);
  });
  const maps = {
    ModelConditionID: crosswalk(input.model_condition, "ModelConditionID"),
    ScreenID: crosswalk(input.screen_sequence_map, "ScreenID"),
    SequencingID: crosswalk(input.omics_profiles, "SequencingID"),
  };
  return { input, maps, models, files, serialized };
}
