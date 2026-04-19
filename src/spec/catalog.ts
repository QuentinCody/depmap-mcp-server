/**
 * DepMap REST API catalog.
 *
 * Source of truth: https://github.com/broadinstitute/depmap-api/blob/master/depmap.yml
 *
 * Note: the DepMap REST API is the *small* surface of the project — per
 * gene/cell-line lookups against the latest release. The bulk Figshare
 * matrices are NOT exposed here; they're ingested into the singleton
 * Durable Object via {@link depmap_load_release} (cron-driven) and
 * queried via {@link depmap_query_data}.
 */

import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const depmapCatalog: ApiCatalog = {
    name: "DepMap (Cancer Dependency Map) REST",
    baseUrl: "https://depmap.org/portal/api",
    version: "1.0",
    auth: "none",
    endpointCount: 15,
    notes:
        "- Per-gene / per-cell-line lookups against the LATEST adult DepMap release.\n" +
        "- For cohort comparisons or panel-wide analytics across versions, use the bulk-staged data:\n" +
        "  Figshare release CSVs are ingested into a singleton Durable Object as long-form\n" +
        "  rows ({entrez_id, gene_symbol, cell_line_id, value, version, dataset}). Query with\n" +
        "  depmap_query_data using SQL like:\n" +
        "    SELECT lineage, AVG(value) FROM gene_effect_24Q4\n" +
        "      JOIN sample_info USING (depmap_id) WHERE entrez_id = 7157 GROUP BY lineage\n" +
        "- The REST API uses two different gene identifier conventions: gene_expression keys\n" +
        "  off Ensembl gene IDs (ENSG...), while gene_dependency / copy_number / rnai /\n" +
        "  mutations key off Entrez gene IDs (integer). Resolve symbols up front via\n" +
        "  biothings_gene_resolve.\n" +
        "- Cell line IDs are DepMap IDs (ACH-NNNNNN format). Use /cell_lines to enumerate.\n" +
        "- Rate limit is undocumented; be conservative (≤2 req/sec) when iterating.\n" +
        "\n" +
        "PEDIATRIC COHORT (PedDep):\n" +
        "  PedDep is bulk-only — no REST endpoints. Use depmap_query_data with the\n" +
        "  '_peddep' table suffix (e.g. gene_effect_peddep) instead of the quarterly\n" +
        "  release tables. PedDep ships from Dharia et al. 2021 (82 lines × 13 tumor\n" +
        "  types) and grows over time as the PedDep Accelerator releases new data.",
    endpoints: [
        // === Metadata ===
        {
            method: "GET",
            path: "/genes",
            summary:
                "List all gene entities known to the DepMap portal — HGNC ID, gene symbol, Ensembl gene ID, Entrez gene ID, and OMIM identifier. Returns ~20k gene records; will auto-stage.",
            category: "metadata",
            featured: true,
        },
        {
            method: "GET",
            path: "/cell_lines",
            summary:
                "List all cell lines profiled in DepMap — DepMap ID, stripped name, CCLE name, aliases, primary disease, lineage. Returns ~1.1k records (full panel).",
            category: "metadata",
            featured: true,
        },
        {
            method: "GET",
            path: "/proteins",
            summary:
                "List protein/antibody entities used in the RPPA protein array dataset. Returns antibody name, target genes, validation status, vendor, and catalog number.",
            category: "metadata",
        },

        // === Expression (RNA-seq) ===
        {
            method: "GET",
            path: "/gene_expression/by_gene/{ensembl_gene}",
            summary:
                "Expression values (TPM/log2) for one gene across all DepMap cell lines, keyed by Ensembl gene ID.",
            category: "gene_expression",
            featured: true,
            pathParams: [
                {
                    name: "ensembl_gene",
                    type: "string",
                    required: true,
                    description: "Ensembl gene ID (e.g. ENSG00000141510 for TP53)",
                },
            ],
            example: 'await api.get("/gene_expression/by_gene/ENSG00000141510")',
        },
        {
            method: "GET",
            path: "/gene_expression/by_cell_line/{depmap_id}",
            summary:
                "Expression values (TPM/log2) for all genes in one cell line, keyed by DepMap ID.",
            category: "gene_expression",
            pathParams: [
                {
                    name: "depmap_id",
                    type: "string",
                    required: true,
                    description: "DepMap cell line ID (e.g. ACH-000001)",
                },
            ],
        },

        // === Dependency (CRISPR Achilles) ===
        {
            method: "GET",
            path: "/gene_dependency/by_gene/{entrez_gene_id}",
            summary:
                "CRISPR knockout dependency scores (Chronos / CERES gene_effect) for one gene across all cell lines. Negative = essential. Keyed by Entrez gene ID.",
            category: "gene_dependency",
            featured: true,
            pathParams: [
                {
                    name: "entrez_gene_id",
                    type: "number",
                    required: true,
                    description: "Entrez gene ID (e.g. 7157 for TP53, 672 for BRCA1)",
                },
            ],
            example: 'await api.get("/gene_dependency/by_gene/7157")',
        },
        {
            method: "GET",
            path: "/gene_dependency/by_cell_line/{depmap_id}",
            summary:
                "CRISPR dependency scores for all genes in one cell line. Use to find what a tumor model 'needs.'",
            category: "gene_dependency",
            featured: true,
            pathParams: [
                {
                    name: "depmap_id",
                    type: "string",
                    required: true,
                    description: "DepMap cell line ID",
                },
            ],
        },

        // === Copy number ===
        {
            method: "GET",
            path: "/copy_number/by_gene/{entrez_gene_id}",
            summary:
                "Relative gene-level copy number (log2 ratio) for one gene across all cell lines.",
            category: "copy_number",
            pathParams: [
                {
                    name: "entrez_gene_id",
                    type: "number",
                    required: true,
                    description: "Entrez gene ID",
                },
            ],
        },
        {
            method: "GET",
            path: "/copy_number/by_cell_line/{depmap_id}",
            summary:
                "Relative copy number values for all genes in one cell line.",
            category: "copy_number",
            pathParams: [
                {
                    name: "depmap_id",
                    type: "string",
                    required: true,
                    description: "DepMap cell line ID",
                },
            ],
        },

        // === RNAi (legacy DEMETER2) ===
        {
            method: "GET",
            path: "/rnai/by_gene/{entrez_gene_id}",
            summary:
                "Legacy RNAi knockdown sensitivity (DEMETER2) for one gene across cell lines. Older, lower-resolution than CRISPR; useful for cross-validation only.",
            category: "rnai",
            pathParams: [
                {
                    name: "entrez_gene_id",
                    type: "number",
                    required: true,
                    description: "Entrez gene ID",
                },
            ],
        },
        {
            method: "GET",
            path: "/rnai/by_cell_line/{depmap_id}",
            summary: "Legacy RNAi knockdown values for all genes in one cell line.",
            category: "rnai",
            pathParams: [
                {
                    name: "depmap_id",
                    type: "string",
                    required: true,
                    description: "DepMap cell line ID",
                },
            ],
        },

        // === Mutations ===
        {
            method: "GET",
            path: "/mutations/by_gene/{entrez_gene_id}",
            summary:
                "Somatic mutations called in one gene across DepMap cell lines — variant classification, protein change, hotspot annotation, allele frequency.",
            category: "mutations",
            featured: true,
            pathParams: [
                {
                    name: "entrez_gene_id",
                    type: "number",
                    required: true,
                    description: "Entrez gene ID",
                },
            ],
        },
        {
            method: "GET",
            path: "/mutations/by_cell_line/{depmap_id}",
            summary: "All mutations called in one cell line.",
            category: "mutations",
            pathParams: [
                {
                    name: "depmap_id",
                    type: "string",
                    required: true,
                    description: "DepMap cell line ID",
                },
            ],
        },

        // === Protein array (RPPA) ===
        {
            method: "GET",
            path: "/protein_array/by_protein/{antibody_name}",
            summary:
                "RPPA (reverse-phase protein array) measurements for one antibody across all cell lines. Validated antibodies only — see /proteins for the catalog.",
            category: "protein_array",
            pathParams: [
                {
                    name: "antibody_name",
                    type: "string",
                    required: true,
                    description: "Antibody name as listed in /proteins",
                },
            ],
        },
        {
            method: "GET",
            path: "/protein_array/by_cell_line/{depmap_id}",
            summary: "RPPA measurements for all antibodies in one cell line.",
            category: "protein_array",
            pathParams: [
                {
                    name: "depmap_id",
                    type: "string",
                    required: true,
                    description: "DepMap cell line ID",
                },
            ],
        },
    ],
};
