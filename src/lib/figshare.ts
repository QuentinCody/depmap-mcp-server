/**
 * Figshare release-source helpers for the depmap MCP server.
 *
 * Two paths into Figshare:
 *   - Adult DepMap releases follow the "DepMap_<NN>Q<N>_Public" naming
 *     convention. We discover them via Figshare's article search endpoint
 *     and pick the highest version.
 *   - PedDep does NOT follow that convention; it's pinned to known
 *     article IDs (Dharia 2021 etc.), fetched directly via the
 *     article-detail endpoint by callers that already know the article.
 *
 * Both paths converge on {@link getReleaseFiles} for the actual
 * download-URL resolution.
 *
 * All HTTP goes through an injectable `fetch` so the scheduled handler
 * and the `depmap_load_release` tool can be exercised under test.
 */

const DEFAULT_BASE_URL = "https://api.figshare.com";
const DEFAULT_USER_AGENT = "depmap-mcp-server/1.0";

export interface FigshareFetchOptions {
    /** Optional fetch implementation; defaults to global fetch. */
    readonly fetch?: typeof fetch;
    /** Override the Figshare API base URL (test injection). */
    readonly baseUrl?: string;
    /** User-Agent header sent with every request. */
    readonly userAgent?: string;
}

/**
 * A normalized DepMap adult release version, e.g. 24Q4.
 * Compared lexicographically by year then quarter via
 * {@link compareReleaseVersions}.
 */
export interface AdultReleaseVersion {
    readonly year: number;
    readonly quarter: number;
    /** Canonical short label, e.g. "24Q4". */
    readonly label: string;
}

export interface AdultReleaseDescriptor {
    readonly version: AdultReleaseVersion;
    readonly articleId: number;
    readonly doi: string;
    readonly title: string;
}

export interface FigshareFile {
    readonly id: number;
    readonly name: string;
    readonly downloadUrl: string;
    readonly sizeBytes: number;
    readonly md5?: string;
}

interface FigshareSearchHit {
    readonly id: number;
    readonly title: string;
    readonly doi?: string;
    readonly published_date?: string;
}

interface FigshareArticleDetail {
    readonly id: number;
    readonly title: string;
    readonly doi: string;
    readonly files: ReadonlyArray<{
        readonly id: number;
        readonly name: string;
        readonly download_url: string;
        readonly size: number;
        readonly computed_md5?: string;
    }>;
}

const ADULT_TITLE_PATTERN = /^DepMap_(\d{2})Q([1-4])_Public$/;

/**
 * Parse a Figshare article title into a normalized version, or return
 * null if the title does not match the canonical adult DepMap pattern.
 *
 * Strict on purpose — we'd rather miss a non-conforming release than
 * silently treat a one-off article as a quarterly drop.
 */
export function parseAdultReleaseVersion(
    title: string,
): AdultReleaseVersion | null {
    const m = ADULT_TITLE_PATTERN.exec(title);
    if (!m) return null;
    const year = Number(m[1]);
    const quarter = Number(m[2]);
    return { year, quarter, label: `${m[1]}Q${m[2]}` };
}

/** Lexicographic comparator: year then quarter. Returns negative, zero, or positive. */
export function compareReleaseVersions(
    a: AdultReleaseVersion,
    b: AdultReleaseVersion,
): number {
    if (a.year !== b.year) return a.year - b.year;
    return a.quarter - b.quarter;
}

async function figshareGet<T>(
    path: string,
    options: FigshareFetchOptions,
): Promise<T> {
    const fetchImpl = options.fetch ?? fetch;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

    const response = await fetchImpl(`${baseUrl}${path}`, {
        headers: {
            accept: "application/json",
            "user-agent": userAgent,
        },
    });
    if (!response.ok) {
        const body = await response.text().catch(() => response.statusText);
        throw new Error(
            `Figshare ${path} failed: HTTP ${response.status} — ${body.slice(0, 200)}`,
        );
    }
    return (await response.json()) as T;
}

/**
 * Discover the highest-versioned adult DepMap release on Figshare.
 * Returns null when no matching articles are found.
 */
export async function findLatestAdultRelease(
    options: FigshareFetchOptions = {},
): Promise<AdultReleaseDescriptor | null> {
    const hits = await figshareGet<FigshareSearchHit[]>(
        "/v2/articles/search?search_for=DepMap_Public&item_type=3&page_size=50",
        options,
    );

    let best: AdultReleaseDescriptor | null = null;
    for (const hit of hits) {
        const version = parseAdultReleaseVersion(hit.title);
        if (!version) continue;
        const descriptor: AdultReleaseDescriptor = {
            version,
            articleId: hit.id,
            doi: hit.doi ?? "",
            title: hit.title,
        };
        if (best === null || compareReleaseVersions(version, best.version) > 0) {
            best = descriptor;
        }
    }
    return best;
}

export interface GetReleaseFilesOptions extends FigshareFetchOptions {
    /** If provided, only files whose `name` is in this list are returned. */
    readonly names?: readonly string[];
}

/**
 * Resolve the file list for a Figshare article (article ID is the
 * stable Figshare identifier, not the DOI).
 */
export async function getReleaseFiles(
    articleId: number,
    options: GetReleaseFilesOptions = {},
): Promise<readonly FigshareFile[]> {
    const detail = await figshareGet<FigshareArticleDetail>(
        `/v2/articles/${articleId}`,
        options,
    );
    const allow = options.names
        ? new Set(options.names)
        : null;
    const out: FigshareFile[] = [];
    for (const f of detail.files) {
        if (allow !== null && !allow.has(f.name)) continue;
        out.push({
            id: f.id,
            name: f.name,
            downloadUrl: f.download_url,
            sizeBytes: f.size,
            md5: f.computed_md5,
        });
    }
    return out;
}
