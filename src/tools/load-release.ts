/**
 * `depmap_load_release` — admin-gated wrapper around the
 * load-release orchestrator.
 *
 * Normally invoked by the daily cron (which bypasses the gate by going
 * through the scheduled handler directly). The MCP-exposed version is
 * gated behind a Bearer token so chat-driven LLMs can't trigger an
 * expensive ingest on a whim.
 *
 * Pure orchestration — the actual load body is injected via
 * {@link LoadReleaseToolDeps.runLoad} so the gate logic is testable
 * without real Figshare or DO infrastructure.
 */

import type {
    LoadReleaseInput,
    LoadReleaseResult,
} from "../lib/load-release";

export interface LoadReleaseToolDeps {
    /** Required Bearer token. If undefined, the tool refuses any request. */
    readonly adminToken: string | undefined;
    /** The actual load implementation (loadRelease + DO wiring). */
    readonly runLoad: (input: LoadReleaseInput) => Promise<LoadReleaseResult>;
}

export interface LoadReleaseToolContext {
    /** Raw value of the request's Authorization header, if any. */
    readonly authorizationHeader: string | undefined;
}

export interface LoadReleaseToolResult extends LoadReleaseResult {
    readonly error?: string;
}

const EMPTY_RESULT = (
    input: LoadReleaseInput,
    error: string,
): LoadReleaseToolResult => ({
    success: false,
    cohort: input.cohort,
    version: input.version,
    totalRowsStaged: 0,
    datasets: [],
    error,
});

export async function runLoadRelease(
    input: LoadReleaseInput,
    deps: LoadReleaseToolDeps,
    context: LoadReleaseToolContext,
): Promise<LoadReleaseToolResult> {
    if (!deps.adminToken) {
        return EMPTY_RESULT(
            input,
            "CONFIG_ERROR: depmap_load_release requires DEPMAP_ADMIN_TOKEN to be configured on the worker.",
        );
    }

    const header = context.authorizationHeader ?? "";
    const expected = `Bearer ${deps.adminToken}`;
    if (header !== expected) {
        return EMPTY_RESULT(
            input,
            "AUTH_ERROR: depmap_load_release requires a valid Bearer token in the Authorization header.",
        );
    }

    try {
        const result = await deps.runLoad(input);
        return result;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return EMPTY_RESULT(input, message);
    }
}
