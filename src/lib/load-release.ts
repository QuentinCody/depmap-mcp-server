/**
 * Load one DepMap release into the singleton Durable Object.
 *
 * Drives the bulk-ingest pipeline:
 *   Figshare release → per-dataset CSV stream → optional pivot → stage
 *
 * All I/O is dependency-injected so the orchestrator can be exercised
 * without real Figshare or DO infrastructure.
 *
 * Two dataset shapes:
 *   - "matrix"     — wide CSV (gene × cell line). Pivoted into long-form
 *                    rows {entrez_id, gene_symbol, cell_line_id, value,
 *                    version, dataset} and staged into a per-dataset,
 *                    per-version table named "<dataset>_<version>".
 *   - "dimension"  — tabular CSV (one row per cell line). Passed through
 *                    as-is and staged into the table name listed by the
 *                    dataset entry.
 */

import { csvStream } from "@bio-mcp/shared/staging/csv-stream";
import { parseCsv } from "@bio-mcp/shared/staging/csv-parser";
import { pivotLongForm } from "@bio-mcp/shared/staging/csv-pivot";
import type { GeneResolver } from "@bio-mcp/shared/biothings/gene-resolver";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";
import type { FigshareFile } from "./figshare";

export type Cohort = "adult" | "pediatric";

export interface LoadReleaseInput {
    readonly cohort: Cohort;
    /** Canonical version label (e.g. "24Q4", "peddep_2021"). Used in tables. */
    readonly version: string;
    /** Figshare article ID for this release. */
    readonly articleId: number;
    readonly doi: string;
}

export interface DatasetSpec {
    readonly name: string;
    /** Filename in the Figshare article. */
    readonly figshareFilename: string;
    /** "matrix" gets pivoted; "dimension" passes through. */
    readonly kind: "matrix" | "dimension";
    /** For dimension datasets, the destination table name. */
    readonly dimensionTableName?: string;
}

export const RELEASE_DATASETS: readonly DatasetSpec[] = [
    {
        name: "gene_effect",
        figshareFilename: "Achilles_gene_effect.csv",
        kind: "matrix",
    },
    {
        name: "gene_dependency",
        figshareFilename: "Achilles_gene_dependency.csv",
        kind: "matrix",
    },
    {
        name: "expression",
        figshareFilename: "CCLE_expression.csv",
        kind: "matrix",
    },
    {
        name: "copy_number",
        figshareFilename: "CCLE_gene_cn.csv",
        kind: "matrix",
    },
    {
        name: "mutations",
        figshareFilename: "CCLE_mutations.csv",
        kind: "dimension",
        dimensionTableName: "mutations",
    },
    {
        name: "sample_info",
        figshareFilename: "sample_info.csv",
        kind: "dimension",
        dimensionTableName: "sample_info",
    },
];

const DATASETS_BY_NAME = new Map(RELEASE_DATASETS.map((d) => [d.name, d]));

/**
 * Result returned by {@link LoadReleaseDeps.stageBatch}. The orchestrator
 * does not need to know the DO's full response shape — only the count of
 * rows it accepted, and whether the call succeeded.
 */
export interface StageBatchResult {
    readonly success: boolean;
    readonly rowsInserted: number;
    readonly error?: string;
}

/**
 * Stage one batch of rows into the singleton DO. The orchestrator passes
 * an optional schema-hints hint so the staging engine targets the right
 * table name (per-dataset for matrix, fixed for dimension).
 */
export type StageBatchFn = (
    rows: readonly Record<string, unknown>[],
    hints?: SchemaHints,
) => Promise<StageBatchResult>;

export interface LoadReleaseDeps {
    /** Resolve files for a given Figshare article (mocked in tests). */
    readonly getReleaseFiles: (
        articleId: number,
        names: readonly string[],
    ) => Promise<readonly FigshareFile[]>;
    /** Open a download stream for a single Figshare file. */
    readonly downloadStream: (
        file: FigshareFile,
    ) => Promise<ReadableStream<Uint8Array>>;
    /** Resolve gene symbols to entrez IDs for matrix pivots. */
    readonly resolveGene: GeneResolver;
    /** Stage a batch of rows into the singleton DO. */
    readonly stageBatch: StageBatchFn;
}

export interface LoadReleaseOptions {
    /** Subset of {@link RELEASE_DATASETS} to process; defaults to all. */
    readonly datasets?: readonly string[];
    /**
     * Maximum rows per stage call. Larger batches reduce DO RPC overhead;
     * smaller batches bound memory. Default 5000.
     */
    readonly batchSize?: number;
}

export interface DatasetResult {
    readonly name: string;
    readonly rowsStaged: number;
    readonly error?: string;
}

export interface LoadReleaseResult {
    readonly success: boolean;
    readonly cohort: Cohort;
    readonly version: string;
    readonly totalRowsStaged: number;
    readonly datasets: readonly DatasetResult[];
}

const DEFAULT_BATCH_SIZE = 5000;

async function processMatrix(
    file: FigshareFile,
    spec: DatasetSpec,
    input: LoadReleaseInput,
    deps: LoadReleaseDeps,
    batchSize: number,
): Promise<number> {
    const stream = await deps.downloadStream(file);
    const wideRows: Record<string, unknown>[] = [];
    let geneColumn: string | null = null;
    let cellLineColumns: string[] = [];

    for await (const row of csvStream(stream, { autoCastNumbers: false })) {
        if (geneColumn === null) {
            const keys = Object.keys(row);
            geneColumn = keys[0] ?? "gene";
            cellLineColumns = keys.slice(1);
        }
        wideRows.push(row);
    }
    if (geneColumn === null) return 0;

    const longForm = await pivotLongForm(wideRows, {
        geneColumn,
        cellLineColumns,
        resolveGene: deps.resolveGene,
    });

    const enriched = longForm.map((r) => ({
        ...r,
        version: input.version,
        dataset: spec.name,
    }));

    let staged = 0;
    for (let i = 0; i < enriched.length; i += batchSize) {
        const batch = enriched.slice(i, i + batchSize);
        const result = await deps.stageBatch(batch, {
            tableName: `${spec.name}_${input.version}`,
            indexes: ["entrez_id", "gene_symbol", "cell_line_id", "version"],
        });
        if (!result.success) {
            throw new Error(result.error ?? "stage failed");
        }
        staged += result.rowsInserted;
    }
    return staged;
}

async function processDimension(
    file: FigshareFile,
    spec: DatasetSpec,
    deps: LoadReleaseDeps,
    batchSize: number,
): Promise<number> {
    const stream = await deps.downloadStream(file);
    // Dimension datasets are small (sample_info ≈ 33 KB) — buffer fully
    // and let parseCsv handle everything in one shot. parseCsv is cheaper
    // than the streaming variant for small inputs because it skips the
    // chunk-boundary state machine overhead.
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
    }
    const text = new TextDecoder("utf-8").decode(merged);
    const rows = parseCsv(text);

    let staged = 0;
    const tableName = spec.dimensionTableName ?? spec.name;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const result = await deps.stageBatch(batch, { tableName });
        if (!result.success) {
            throw new Error(result.error ?? "stage failed");
        }
        staged += result.rowsInserted;
    }
    return staged;
}

export async function loadRelease(
    input: LoadReleaseInput,
    deps: LoadReleaseDeps,
    options: LoadReleaseOptions = {},
): Promise<LoadReleaseResult> {
    const requestedNames =
        options.datasets ?? RELEASE_DATASETS.map((d) => d.name);
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

    const requested: DatasetSpec[] = [];
    for (const name of requestedNames) {
        const spec = DATASETS_BY_NAME.get(name);
        if (!spec) {
            // Unknown dataset names are an integration error, not a
            // per-dataset failure — fail fast so misconfigurations are loud.
            throw new Error(`Unknown dataset: ${name}`);
        }
        requested.push(spec);
    }

    const filenames = requested.map((d) => d.figshareFilename);
    const files = await deps.getReleaseFiles(input.articleId, filenames);
    const filesByName = new Map(files.map((f) => [f.name, f]));

    const datasetResults: DatasetResult[] = [];
    let totalRowsStaged = 0;

    for (const spec of requested) {
        const file = filesByName.get(spec.figshareFilename);
        if (!file) {
            datasetResults.push({
                name: spec.name,
                rowsStaged: 0,
                error: `Figshare file missing: ${spec.figshareFilename}`,
            });
            continue;
        }
        try {
            const rows =
                spec.kind === "matrix"
                    ? await processMatrix(file, spec, input, deps, batchSize)
                    : await processDimension(file, spec, deps, batchSize);
            datasetResults.push({ name: spec.name, rowsStaged: rows });
            totalRowsStaged += rows;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            datasetResults.push({
                name: spec.name,
                rowsStaged: 0,
                error: msg,
            });
        }
    }

    const success = datasetResults.every((d) => d.error === undefined);
    return {
        success,
        cohort: input.cohort,
        version: input.version,
        totalRowsStaged,
        datasets: datasetResults,
    };
}
