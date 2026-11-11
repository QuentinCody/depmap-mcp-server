import { expect, it } from "vitest";
import { harmonize } from "./harmonize";

const pin = (filename: string, rows: Record<string, unknown>[], release = "fixture-release") => ({ filename, release, md5_hash: "1".repeat(32), rows });
function fixture() {
  return {
    model: pin("Model.csv", [{ ModelID: "ACH-1", OncotreeLineage: "Lung" }]),
    model_condition: pin("ModelCondition.csv", [{ ModelConditionID: "MC-1", ModelID: "ACH-1", Drug: "condition drug" }]),
    screen_sequence_map: pin("ScreenSequenceMap.csv", [
      { ScreenID: "SC-1", ModelID: "ACH-1", ModelConditionID: "MC-1", SequenceID: "a" },
      { ScreenID: "SC-1", ModelID: "ACH-1", ModelConditionID: "MC-1", SequenceID: "b" },
    ]),
    omics_profiles: pin("OmicsProfiles.csv", [{ SequencingID: "CDS-1", ModelID: "ACH-1", ModelConditionID: "MC-1", IsDefaultEntryForModel: "No", IsDefaultEntryForMC: "Yes" }]),
    datasets: [
      { ...pin("ScreenGeneEffect.csv", [{ ScreenID: "SC-1", "TP53 (7157)": -0.5 }]), kind: "crispr" as const, index_type: "ScreenID" as const, index_column: "ScreenID" },
      { ...pin("expression.csv", [{ id: "CDS-1", "ENSG00000141510": 1.2 }]), kind: "omics" as const, index_type: "SequencingID" as const, index_column: "id" },
      { ...pin("prism.csv", [{ model: "ACH-1", compound: "BRD-fixture", dose: 1, value: 0.7 }], "independent-prism-release"), kind: "prism" as const, index_type: "ModelID" as const, index_column: "model" },
    ],
  };
}

it("associates CRISPR, omics and independent PRISM rows without collapsing conditions or defaults", async () => {
  const input = fixture();
  const result = await harmonize(input);
  expect(result.inputs).toEqual(input);
  expect(result).toMatchObject({ row_count: 3, matched_rows: 3, unmatched_rows: 0, complete: true });
  expect(result.links.map(row => row.model_row_index)).toEqual([0, 0, 0]);
  expect(result.links.map(row => row.model_condition_id)).toEqual(["MC-1", "MC-1", null]);
  expect(result.links[0].mapping_row_indices).toEqual([0, 1]);
  expect(result.inputs.omics_profiles?.rows[0].IsDefaultEntryForModel).toBe("No");
  expect(result.inputs.datasets[2].release).toBe("independent-prism-release");
  expect(result.provenance).toContain("have not been verified");
});

it("reports unmatched observations without dropping them or name matching", async () => {
  const input = fixture();
  input.datasets[0].rows = [{ ScreenID: "unknown", CellLineName: "Lung" }, { "TP53 (7157)": -1 }];
  input.datasets[2].rows = [{ model: "ACH-missing" }];
  const result = await harmonize(input);
  expect(result.links.map(row => row.status)).toEqual(["unmapped_index", "missing_index", "matched", "missing_model"]);
  expect(result).toMatchObject({ complete: false, unmatched_rows: 3, row_count: 4 });
});

it("refuses release drift for mappings and release datasets", async () => {
  const input = fixture(); input.omics_profiles.release = "different";
  await expect(harmonize(input)).rejects.toThrow(/same DepMap release/);
  input.omics_profiles.release = input.model.release; input.datasets[0].release = "different";
  await expect(harmonize(input)).rejects.toThrow(/pin the mapping release/);
});

it("does not borrow release-specific screen/condition/sequencing maps for independent PRISM data", async () => {
  const input = fixture();
  const independent = { ...input, datasets: [{ ...input.datasets[0], kind: "prism", release: "independent" }] };
  await expect(harmonize(independent)).rejects.toThrow(/must link by ModelID/);
});

it("rejects ambiguous crosswalks and duplicate model metadata", async () => {
  const input = fixture(); input.screen_sequence_map.rows[1].ModelID = "ACH-2";
  await expect(harmonize(input)).rejects.toThrow(/Ambiguous ScreenID/);
  const duplicate = fixture(); duplicate.model.rows.push(duplicate.model.rows[0]);
  await expect(harmonize(duplicate)).rejects.toThrow(/unique/);
});

it("rejects conflicts in direct identifiers and condition crosswalks", async () => {
  const input = fixture(); input.datasets[0].rows[0].ModelID = "ACH-conflict";
  await expect(harmonize(input)).rejects.toThrow(/Conflicting ModelID/);
  delete input.datasets[0].rows[0].ModelID;
  input.model_condition.rows[0].ModelID = "ACH-conflict";
  await expect(harmonize(input)).rejects.toThrow(/Condition maps to a different model/);
});

it("requires exact string identifiers and explicit, valid file pins", async () => {
  const input = fixture(); input.datasets[0].rows[0].ScreenID = 1;
  await expect(harmonize(input)).rejects.toThrow(/exact string/);
  const unpinned = fixture(); unpinned.model.md5_hash = "";
  await expect(harmonize(unpinned)).rejects.toThrow();
});

it("bounds total rows and encoded input size before joining", async () => {
  const input = fixture(); input.datasets[0].rows = Array.from({ length: 5000 }, () => ({ ScreenID: "SC-1" }));
  await expect(harmonize(input)).rejects.toThrow(/5000 total/);
  input.datasets[0].rows = [{ ScreenID: "SC-1", notes: "α".repeat(510_000) }];
  await expect(harmonize(input)).rejects.toThrow(/1MB/);
});
