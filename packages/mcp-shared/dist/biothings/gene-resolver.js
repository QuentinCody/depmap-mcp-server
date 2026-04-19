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
const DEFAULT_BASE_URL = "https://mygene.info/v3";
const DEFAULT_USER_AGENT = "bio-mcp/gene-resolver";
const SCOPES = "symbol,alias,entrezgene,ensembl.gene";
const FIELDS = "entrezgene,ensembl.gene,ensembl.protein,uniprot.Swiss-Prot,HGNC,symbol,alias";
const MAX_BATCH_SIZE = 1000;
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}
function extractEnsemblGene(hit) {
    const e = hit.ensembl;
    if (!e)
        return undefined;
    if (Array.isArray(e))
        return e[0]?.gene;
    return e.gene;
}
function extractEnsemblProteins(hit) {
    const e = hit.ensembl;
    if (!e)
        return undefined;
    const items = Array.isArray(e) ? e : [e];
    const proteins = [];
    for (const item of items) {
        const p = item.protein;
        if (Array.isArray(p))
            proteins.push(...p);
        else if (typeof p === "string")
            proteins.push(p);
    }
    return proteins.length > 0 ? proteins : undefined;
}
function extractUniprot(hit) {
    const sp = hit.uniprot?.["Swiss-Prot"];
    if (!sp)
        return undefined;
    return typeof sp === "string" ? sp : sp[0];
}
function extractAliases(hit) {
    const a = hit.alias;
    if (!a)
        return undefined;
    return typeof a === "string" ? [a] : a;
}
function parseHit(hit) {
    if (hit.notfound) {
        return { query: hit.query, found: false };
    }
    return {
        query: hit.query,
        found: true,
        entrezgene: hit.entrezgene,
        symbol: hit.symbol,
        ensembl_gene: extractEnsemblGene(hit),
        ensembl_protein: extractEnsemblProteins(hit),
        uniprot: extractUniprot(hit),
        hgnc: hit.HGNC,
        aliases: extractAliases(hit),
    };
}
/**
 * Build a {@link GeneResolver} backed by MyGene.info.
 * Default base URL: https://mygene.info/v3
 */
export function createMyGeneResolver(options = {}) {
    const fetchImpl = options.fetch ?? fetch;
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    return async function resolve(identifiers, opts) {
        const out = new Map();
        if (identifiers.length === 0)
            return out;
        const species = opts?.species === undefined ? "human" : opts.species;
        for (const batch of chunk(identifiers, MAX_BATCH_SIZE)) {
            const params = new URLSearchParams();
            params.set("q", batch.join(","));
            params.set("scopes", SCOPES);
            params.set("fields", FIELDS);
            if (species !== null)
                params.set("species", species);
            const response = await fetchImpl(`${baseUrl}/query`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    "user-agent": userAgent,
                },
                body: params.toString(),
                signal: opts?.signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => response.statusText);
                throw new Error(`MyGene.info query failed: HTTP ${response.status} — ${body.slice(0, 200)}`);
            }
            const data = (await response.json());
            if (!Array.isArray(data))
                continue;
            for (const hit of data) {
                out.set(hit.query, parseHit(hit));
            }
        }
        return out;
    };
}
//# sourceMappingURL=gene-resolver.js.map