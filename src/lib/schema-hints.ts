/**
 * Decide the SchemaHints to attach to a depmap staging batch.
 *
 * Pure function — no DO state, no I/O. Called by DepMapDataDO.getSchemaHints
 * (and exercised directly in tests).
 *
 * Two known shapes:
 *   - Long-form measurement rows (gene_effect, gene_dependency, expression,
 *     copy_number, mutations, fusions). Carry { entrez_id, gene_symbol,
 *     cell_line_id, value, version, dataset } and route to a per-dataset,
 *     per-version table named "<dataset>_<version>".
 *   - sample_info dimension rows. Carry { depmap_id, lineage, ... } and
 *     route to a single shared table "sample_info".
 *
 * Anything else falls through to undefined so the staging engine's generic
 * inference handles it.
 */

import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

interface MeasurementRow {
    readonly entrez_id: number | null;
    readonly gene_symbol: string;
    readonly cell_line_id: string;
    readonly value: number | null;
    readonly version: string;
    readonly dataset: string;
}

interface SampleInfoRow {
    readonly depmap_id: string;
    readonly lineage?: unknown;
    readonly primary_disease?: unknown;
}

function isObject(x: unknown): x is Record<string, unknown> {
    return x !== null && typeof x === "object" && !Array.isArray(x);
}

function isMeasurementRow(x: unknown): x is MeasurementRow {
    if (!isObject(x)) return false;
    return (
        "entrez_id" in x &&
        "gene_symbol" in x &&
        "cell_line_id" in x &&
        "value" in x &&
        "version" in x &&
        "dataset" in x &&
        typeof x.dataset === "string" &&
        typeof x.version === "string"
    );
}

function isSampleInfoRow(x: unknown): x is SampleInfoRow {
    if (!isObject(x)) return false;
    if (typeof x.depmap_id !== "string") return false;
    // Minimum signal: depmap_id plus at least one of the canonical fields.
    return (
        "lineage" in x ||
        "primary_disease" in x ||
        "stripped_cell_line_name" in x
    );
}

export function decideSchemaHints(data: unknown): SchemaHints | undefined {
    if (!Array.isArray(data) || data.length === 0) return undefined;
    const sample = data[0];

    if (isMeasurementRow(sample)) {
        return {
            tableName: `${sample.dataset}_${sample.version}`,
            indexes: ["entrez_id", "gene_symbol", "cell_line_id", "version"],
        };
    }

    if (isSampleInfoRow(sample)) {
        return {
            tableName: "sample_info",
            indexes: ["depmap_id", "lineage", "primary_disease"],
        };
    }

    return undefined;
}
