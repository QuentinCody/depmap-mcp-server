/**
 * Wide-matrix → long-form pivot for genomic CSVs (DepMap, PedDep, GTEx
 * bulk, any "rows = genes, cols = samples" matrix).
 *
 * SQLite caps tables at 2k columns; DepMap matrices ship as
 * ~18k genes × ~1k cell lines. This helper melts the wide form into
 * row-per-(gene, cell_line, value) tuples that fit a normal staging
 * table layout.
 *
 * Gene resolution (symbol → entrez) is delegated to a {@link GeneResolver}
 * — production wires this to MyGene.info via
 * `@bio-mcp/shared/biothings/gene-resolver`. Tests pass a fake.
 */
import type { GeneResolver } from "../biothings/gene-resolver";
export interface LongFormRow {
    readonly entrez_id: number | null;
    readonly gene_symbol: string;
    readonly cell_line_id: string;
    readonly value: number | null;
}
export interface PivotLongFormOptions {
    /** Header name of the column carrying gene identifiers. */
    readonly geneColumn: string;
    /** Headers of the columns to melt — typically the cell-line IDs. */
    readonly cellLineColumns: readonly string[];
    /** Optional gene resolver; omit for entrez_id: null on every row. */
    readonly resolveGene?: GeneResolver;
    /**
     * String values that should melt to {@link LongFormRow.value} = null.
     * Default: ["NA", "NaN", "", "null"].
     */
    readonly nullSentinels?: readonly string[];
}
/**
 * Pivot wide rows (one row per gene, one column per cell line) into
 * long-form rows (one row per gene × cell line pair).
 */
export declare function pivotLongForm(rows: readonly Record<string, unknown>[], options: PivotLongFormOptions): Promise<LongFormRow[]>;
//# sourceMappingURL=csv-pivot.d.ts.map