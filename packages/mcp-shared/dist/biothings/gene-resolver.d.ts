/**
 * Typed gene resolution contract.
 *
 * Mirrors the call surface of the biothings-mcp-server's
 * `biothings_gene_resolve` tool so that any MCP server (depmap, peddep,
 * future bulk-ingest servers) can resolve gene symbols to authoritative
 * cross-references with the same shape biothings already exposes.
 *
 * The default implementation calls MyGene.info directly with the same
 * scopes/fields biothings uses internally — no cross-server MCP RPC.
 */
export interface GeneResolution {
    readonly query: string;
    readonly found: boolean;
    readonly entrezgene?: number;
    readonly symbol?: string;
    readonly ensembl_gene?: string;
    readonly ensembl_protein?: readonly string[];
    readonly uniprot?: string;
    readonly hgnc?: string;
    readonly aliases?: readonly string[];
}
export interface GeneResolverOptions {
    /** NCBI taxonomy filter (default: "human"). Pass null for no filter. */
    readonly species?: string | null;
    /** Optional abort signal for fetch cancellation. */
    readonly signal?: AbortSignal;
}
export type GeneResolver = (identifiers: readonly string[], options?: GeneResolverOptions) => Promise<ReadonlyMap<string, GeneResolution>>;
export interface CreateMyGeneResolverOptions {
    /** Optional fetch implementation; defaults to global fetch. */
    readonly fetch?: typeof fetch;
    /** User-Agent header sent with every request. */
    readonly userAgent?: string;
    /** Override the MyGene.info base URL (test injection). */
    readonly baseUrl?: string;
}
/**
 * Build a {@link GeneResolver} backed by MyGene.info.
 * Default base URL: https://mygene.info/v3
 */
export declare function createMyGeneResolver(options?: CreateMyGeneResolverOptions): GeneResolver;
//# sourceMappingURL=gene-resolver.d.ts.map