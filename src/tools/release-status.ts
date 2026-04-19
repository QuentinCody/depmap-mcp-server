/**
 * `depmap_release_status` — read the singleton DO state and report which
 * cohorts have been ingested, at which version, with how many rows.
 *
 * Pure orchestration over a {@link ReleaseStatusDeps} interface so the
 * tool body is exercisable without a real DO. The wrapping into
 * server.registerTool happens in `src/index.ts`.
 */

import type { Cohort } from "../lib/load-release";

export interface CohortStats {
    readonly datasets: number;
    readonly totalRows: number;
}

export interface CohortStatus {
    readonly currentVersion: string | null;
    readonly stats: CohortStats | null;
}

export interface ReleaseStatusResult {
    readonly success: boolean;
    readonly cohorts: {
        readonly adult: CohortStatus;
        readonly pediatric: CohortStatus;
    };
    readonly error?: string;
}

export interface ReleaseStatusDeps {
    readonly getCurrentVersion: (cohort: Cohort) => Promise<string | null>;
    readonly getCohortStats: (cohort: Cohort) => Promise<CohortStats | null>;
}

const EMPTY: CohortStatus = { currentVersion: null, stats: null };

export async function runReleaseStatus(
    deps: ReleaseStatusDeps,
): Promise<ReleaseStatusResult> {
    try {
        const [adultVersion, adultStats, pedVersion, pedStats] =
            await Promise.all([
                deps.getCurrentVersion("adult"),
                deps.getCohortStats("adult"),
                deps.getCurrentVersion("pediatric"),
                deps.getCohortStats("pediatric"),
            ]);
        return {
            success: true,
            cohorts: {
                adult: { currentVersion: adultVersion, stats: adultStats },
                pediatric: { currentVersion: pedVersion, stats: pedStats },
            },
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            cohorts: { adult: EMPTY, pediatric: EMPTY },
            error: message,
        };
    }
}
