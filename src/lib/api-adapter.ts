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
        if (request.method !== "GET") {
            throw new Error(
                `DepMap REST is read-only (GET only); ${request.method} not supported`,
            );
        }

        const url = buildUrl(baseUrl, request.path, request.params);
        const response = await fetchImpl(url, {
            method: "GET",
            headers: {
                accept: "application/json",
                "user-agent": userAgent,
            },
        });

        const contentType = response.headers.get("content-type") ?? "";
        const isJson = contentType.includes("json");

        if (!response.ok) {
            const body = isJson
                ? await response.json().catch(() => null)
                : await response.text().catch(() => response.statusText);
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

        if (isJson) {
            return { status: response.status, data: await response.json() };
        }
        return { status: response.status, data: await response.text() };
    };
}
