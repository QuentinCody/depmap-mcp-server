/**
 * Scheduled handler for the depmap MCP server.
 *
 * Runs daily via the wrangler.jsonc cron trigger. For each cohort:
 *   1. Ask Figshare for the latest release.
 *   2. Compare against the current version recorded in the singleton DO.
 *   3. If newer (or no current version), trigger {@link loadRelease}.
 *
 * The handler is wrapped in a result-typed envelope: it never throws,
 * so a transient Figshare or DO failure doesn't poison the cron retry
 * window. Errors are surfaced via `{ action: "error", error: <msg> }`.
 */

import type {
    AdultReleaseDescriptor,
    FigshareFetchOptions,
} from "./figshare";
import type { Cohort, LoadReleaseInput } from "./load-release";

export type SchedulerAction =
    | "no_release_found"
    | "up_to_date"
    | "load_triggered"
    | "error";

export interface SchedulerResult {
    readonly cohort: Cohort;
    readonly action: SchedulerAction;
    /** Latest version label observed (when action is up_to_date or load_triggered). */
    readonly version?: string;
    readonly error?: string;
}

export interface SchedulerDeps {
    /** Figshare adult-release discovery (mocked in tests). */
    readonly findLatestAdultRelease: (
        opts?: FigshareFetchOptions,
    ) => Promise<AdultReleaseDescriptor | null>;
    /** Figshare pediatric-release discovery — only required when cohort is pediatric. */
    readonly findLatestPediatricRelease?: () => Promise<AdultReleaseDescriptor | null>;
    /** Read the current ingested version label from the singleton DO. */
    readonly getCurrentVersion: (cohort: Cohort) => Promise<string | null>;
    /** Side-effect: enqueue or run a full load for this release. */
    readonly triggerLoadRelease: (input: LoadReleaseInput) => Promise<void>;
}

export async function checkAndIngestLatest(
    cohort: Cohort,
    deps: SchedulerDeps,
): Promise<SchedulerResult> {
    try {
        const latest =
            cohort === "adult"
                ? await deps.findLatestAdultRelease()
                : await (deps.findLatestPediatricRelease?.() ?? Promise.resolve(null));

        if (latest === null) {
            return { cohort, action: "no_release_found" };
        }

        const current = await deps.getCurrentVersion(cohort);
        if (current === latest.version.label) {
            return { cohort, action: "up_to_date", version: current };
        }

        await deps.triggerLoadRelease({
            cohort,
            version: latest.version.label,
            articleId: latest.articleId,
            doi: latest.doi,
        });
        return {
            cohort,
            action: "load_triggered",
            version: latest.version.label,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { cohort, action: "error", error: message };
    }
}
