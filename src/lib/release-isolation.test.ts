import { expect, it, vi } from "vitest";
import { loadRelease, type LoadReleaseDeps } from "./load-release";

function dependencies(csv: string, filename = "sample_info.csv") {
  const writes: { rows: readonly Record<string, unknown>[]; table?: string }[] = [];
  const deps: LoadReleaseDeps = {
    getReleaseFiles: async () => [{ id: 1, name: filename, downloadUrl: "https://fixture.invalid/file", sizeBytes: csv.length }],
    downloadStream: async () => new Response(csv).body as ReadableStream<Uint8Array>,
    resolveGene: vi.fn(async () => new Map()),
    stageBatch: async (rows, hints) => { writes.push({ rows, table: hints?.tableName }); return { success: true, rowsInserted: rows.length }; },
  };
  return { deps, writes };
}
const input = { cohort: "adult" as const, version: "fixtureA", articleId: 1, doi: "fixture" };

it("separates dimension tables across releases and preserves identifiers as strings", async () => {
  const { deps, writes } = dependencies("depmap_id,lineage,external_id\nACH-1,Lung,9007199254740993\n");
  await loadRelease(input, deps, { datasets: ["sample_info"] });
  await loadRelease({ ...input, version: "fixtureB" }, deps, { datasets: ["sample_info"] });
  expect(writes.map(write => write.table)).toEqual(["sample_info_fixtureA", "sample_info_fixtureB"]);
  expect(writes[0].rows[0]).toMatchObject({ external_id: "9007199254740993", _depmap_release: "fixtureA" });
  expect(writes[1].rows[0]._depmap_release).toBe("fixtureB");
});

it("refuses a model-by-gene matrix before staging or gene resolution", async () => {
  const { deps, writes } = dependencies("ModelID,TP53 (7157),BRAF (673)\nACH-1,-0.1,-0.2\n", "Achilles_gene_effect.csv");
  const result = await loadRelease(input, deps, { datasets: ["gene_effect"] });
  expect(result).toMatchObject({ success: false, totalRowsStaged: 0, datasets: [{ error: expect.stringContaining("Legacy loader requires") }] });
  expect(writes).toEqual([]); expect(deps.resolveGene).not.toHaveBeenCalled();
});

it("rejects unsafe suffixes and invalid batch sizes before fetching files", async () => {
  const { deps } = dependencies("");
  await expect(loadRelease({ ...input, version: "a-b" }, deps)).rejects.toThrow(/suffix/);
  await expect(loadRelease(input, deps, { batchSize: 0 })).rejects.toThrow(/batchSize/);
});
