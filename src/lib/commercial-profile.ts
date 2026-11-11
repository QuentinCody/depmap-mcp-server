/**
 * The commercial license profile for DepMap.
 *
 * License audit 2026-11-10: "Allow only the files that permit commercial use.
 * Broad DepMap Public releases are CC BY 4.0; Sanger DepMap data does not
 * permit commercial use without consent; the legacy CCLE terms are unclear."
 *
 * Facts from the providers, read on 2026-11-10, that set the rule:
 * - The DepMap portal does not release data under CC BY 4.0 now. DepMap staff
 *   quote the current terms (forum.depmap.org/t/4652, 2026-07-28): "Commercial
 *   Use of the Data is not permitted under these terms and may require a
 *   separate license agreement from Broad or its contributors." And
 *   (forum.depmap.org/t/4686, 2026-09-25): "We used to deposit data into
 *   figshare under a CC4.0 license, but stopped doing when DepMap switched to
 *   terms of use which were not compatible with the CC4.0 license."
 * - CC BY 4.0 is confirmed only for the files of the figshare records
 *   "DepMap Achilles 18Q3 public" to "DepMap 24Q4 Public" (the `license` field
 *   of api.figshare.com/v2/articles/<id>). No route of this server reads those
 *   records. A stored snapshot is pinned to the portal inventory, not to a
 *   figshare record.
 * - Those releases contain Sanger data. README.txt of DepMap 24Q4 Public:
 *   "Achilles combined with Sanger's Project SCORE (KY Cas9 library) screens".
 *   Sanger (depmap.sanger.ac.uk/documentation/data-usage-policy): "Commercial
 *   use of the Cancer Dependency Map at Sanger API and/or data is not permitted
 *   without prior consent."
 * - The legacy CCLE terms give no license. DepMap staff
 *   (forum.depmap.org/t/3063, 2024-02-02): "I'm not sure I can easily say what
 *   the terms for all CCLE data are."
 * - Each REST route goes to depmap.org/portal/api. The reply does not name a
 *   release or a file, so a route cannot be tied to a CC BY 4.0 deposit.
 *
 * Thus no route and no stored release file is confirmed for commercial use.
 * A reselling caller (`licenseProfile: "commercial"`) gets HTTP 451 for each
 * route, and cannot read an imported snapshot or the legacy release tables.
 * A caller without the profile sees no change.
 */

import { getRequestLicenseProfile, type MaybeExtra } from "@bio-mcp/shared";
import { adapterFailureMessage, commercialUseRefusal } from "@bio-mcp/shared/codemode/catalog";
import { createCodeModeError } from "@bio-mcp/shared/codemode/response";

type Refusal = ReturnType<typeof commercialUseRefusal>;

/**
 * Routes of the portal API that a commercial product may serve. The list is
 * empty: see the facts above. A route that is not in the list is refused, so
 * an unknown route fails closed. Add a route only when its data files are
 * confirmed for commercial use.
 */
export const COMMERCIAL_ROUTES: readonly string[] = [];

const ROUTE_TERMS =
    "the DepMap portal terms do not permit commercial use of its data without a separate license from Broad, " +
    "and the reply does not identify a release that was deposited under CC BY 4.0. " +
    "No route of this API is confirmed for commercial use";

const HANDLE_TERMS =
    "it holds complete DepMap release files, and no stored file is confirmed for commercial use. " +
    "The current DepMap terms require a separate license from Broad, Sanger DepMap data requires consent, " +
    "and the legacy CCLE terms are unclear";

/** The route of a request path: no query string, no fragment, no final slash. */
function routeOf(path: string): string {
    return path.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
}

/** True only for a route in {@link COMMERCIAL_ROUTES}. The comparison is exact. */
export function isCommercialRoute(path: string): boolean {
    return COMMERCIAL_ROUTES.includes(routeOf(path));
}

/** The HTTP 451 result for a route that a commercial caller cannot get, or undefined. */
export function commercialRouteRefusal(path: string): Refusal | undefined {
    if (isCommercialRoute(path)) return undefined;
    return commercialUseRefusal(`DepMap portal route ${routeOf(path).slice(0, 200)}`, ROUTE_TERMS);
}

/**
 * Handles of stores that hold DepMap release files:
 * - `depmap_bulk_<cohort>_<UUID>`: an imported snapshot (`depmap_rows`,
 *   `depmap_chunks`: all cells and all original bytes of each selected file).
 * - `adult:current` / `pediatric:current`: the alias of the published snapshot.
 * - `release:<cohort>:current`: the legacy tables of the retired Figshare
 *   loader. They do not record the article that they came from.
 * An ordinary staged response has the form `depmap_<time>_<hex>`.
 */
const IMPORTED_HANDLE = /^\s*(?:depmap_bulk_|release:|(?:adult|pediatric):current\s*$)/i;

/** The HTTP 451 result for a handle that a commercial caller cannot read, or undefined. */
export function commercialHandleRefusal(dataAccessId: unknown): Refusal | undefined {
    // The same conversion that the handlers apply to the argument.
    const handle = String(dataAccessId ?? "");
    if (!IMPORTED_HANDLE.test(handle)) return undefined;
    return commercialUseRefusal(`DepMap release data in ${handle.trim().slice(0, 120)}`, HANDLE_TERMS);
}

/**
 * The tool error for a hand-built tool (`depmap_query_data`,
 * `depmap_get_schema`) when a commercial caller names an imported handle.
 * Undefined for a caller without the profile and for an ordinary handle.
 * `extra` is the second argument of the tool handler.
 */
export function commercialHandleError(dataAccessId: unknown, extra: unknown) {
    if (getRequestLicenseProfile(extra as MaybeExtra | undefined) !== "commercial") return undefined;
    const refusal = commercialHandleRefusal(dataAccessId);
    if (!refusal) return undefined;
    return createCodeModeError(String(refusal.data.error), String(refusal.data.message), {
        status: refusal.status,
    });
}

type DataNamespace = Pick<DurableObjectNamespace, "idFromName" | "get">;

/**
 * The staging namespace for the Code Mode isolate of a commercial caller.
 * `api.query()` and `db.queryStaged()` open a store by its name, without the
 * API adapter and without `depmap_query_data`. This view refuses the names of
 * the stores that hold release files. It does not change other names.
 */
export function commercialDataNamespace(namespace: DataNamespace): DataNamespace {
    return {
        idFromName(name) {
            const refusal = commercialHandleRefusal(name);
            if (refusal) throw new Error(adapterFailureMessage(refusal.status, refusal.data));
            return namespace.idFromName(name);
        },
        get: (...args) => namespace.get(...args),
    };
}
