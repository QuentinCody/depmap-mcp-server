/**
 * Co-located smoke tests for the schema-hints decision logic.
 *
 * The exhaustive suite (per-dataset table naming, sample_info detection,
 * passthrough on unknown shapes) lives at:
 *
 *   tests/depmap-schema-hints.test.ts
 */
import { describe, expect, it } from "vitest";
import { decideSchemaHints } from "./schema-hints";

describe("decideSchemaHints (smoke)", () => {
    it("emits per-dataset, per-version table names for measurement rows", () => {
        const hints = decideSchemaHints([
            {
                entrez_id: 7157,
                gene_symbol: "TP53",
                cell_line_id: "ACH-1",
                value: 0,
                version: "24Q4",
                dataset: "gene_effect",
            },
        ]);
        expect(hints?.tableName).toBe("gene_effect_24Q4");
    });
});
