/**
 * DepMap REST → ApiFetchFn adapter.
 *
 * Bridges the Code Mode `<prefix>_execute` tool's `api.get(path, params)`
 * helper to the DepMap portal REST API. The DepMap REST surface is
 * read-only (per https://github.com/broadinstitute/depmap-api), so this
 * adapter only supports GET — POST/PUT/DELETE throw immediately.
 */

import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { depmapCatalog } from "../spec/catalog";
import { commercialRouteRefusal } from "./commercial-profile";
import { discoverReleases, discoverySelectors, METADATA_PATH } from "./release-discovery";
import { readDepMapResponse } from "./response";

export interface CreateDepMapApiFetchOptions {
    /** Optional fetch implementation; defaults to global fetch. */
    readonly fetch?: typeof fetch;
    /** Override the catalog base URL (test injection). */
    readonly baseUrl?: string;
    /** User-Agent header sent with every request. */
    readonly userAgent?: string;
}

const DEFAULT_USER_AGENT = "depmap-mcp-server/1.0";

function buildUrl(
    baseUrl: string,
    path: string,
    params?: Record<string, unknown>,
): string {
    const url = new URL(`${baseUrl}${path}`);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null) continue;
            url.searchParams.set(k, String(v));
        }
    }
    return url.toString();
}

export function createDepMapApiFetch(
    options: CreateDepMapApiFetchOptions = {},
): ApiFetchFn {
    const fetchImpl = options.fetch ?? fetch;
    const baseUrl = options.baseUrl ?? depmapCatalog.baseUrl;
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

    return async (request) => {
        // A reselling caller gets no portal data: no route is confirmed for
        // commercial use (see ./commercial-profile). No upstream request.
        if (request.licenseProfile === "commercial") {
            const refusal = commercialRouteRefusal(request.path);
            if (refusal) return refusal;
        }
        if (request.method !== "GET") {
            throw new Error(
                `DepMap REST is read-only (GET only); ${request.method} not supported`,
            );
        }

        const metadata = request.path === METADATA_PATH;
        if (metadata) discoverySelectors(request.params);
        const url = buildUrl(baseUrl, request.path, metadata ? undefined : request.params);
        const response = await fetchImpl(url, {
            method: "GET",
            headers: {
                accept: metadata ? "text/csv" : "application/json",
                "user-agent": userAgent,
            },
            signal: AbortSignal.timeout(30_000),
            redirect: "manual",
        });

        const contentType = response.headers.get("content-type") ?? "";
        const isJson = contentType.includes("json");
        const text = await readDepMapResponse(response);

        if (!response.ok) {
            let body: unknown = text;
            if (isJson) { try { body = JSON.parse(text); } catch { /* Keep upstream text. */ } }
            const message = `HTTP ${response.status}: ${
                typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)
            }`;
            const error = new Error(message) as Error & {
                status: number;
                data: unknown;
            };
            error.status = response.status;
            error.data = body;
            throw error;
        }

        if (metadata) {
            if (!contentType.toLowerCase().includes("text/csv")) throw new Error("DepMap inventory did not return CSV; possible access challenge or upstream format change");
            return { status: response.status, data: await discoverReleases(text, request.params) };
        }
        return { status: response.status, data: isJson ? JSON.parse(text) : text };
    };
}
