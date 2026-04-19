/**
 * Singleton Durable Object backing the depmap MCP server.
 *
 * The depmap server uses two well-known DO instances (one per cohort),
 * routed via `idFromName("release:adult:current")` /
 * `idFromName("release:pediatric:current")`. Every chat session reads
 * through the SAME instance — that's the point of bulk-staged shared
 * reference data.
 *
 * The DO inherits all HTTP routes from {@link RestStagingDO}:
 *   /process /query /query-enhanced /schema /delete
 *
 * The only depmap-specific override is {@link getSchemaHints}, delegated
 * to the pure-function decider in src/lib/schema-hints.ts.
 */

import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";
import { decideSchemaHints } from "./lib/schema-hints";

export class DepMapDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        return decideSchemaHints(data);
    }
}
