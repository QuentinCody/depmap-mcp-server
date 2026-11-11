/**
 * DepMap staging, immutable bulk generations and cohort publication pointers.
 * Existing release:<cohort>:current objects coordinate atomic pointer changes;
 * each depmap_bulk_<cohort>_<UUID> stores one explicit selected-file snapshot.
 * Ordinary staged responses retain RestStagingDO routes. Bulk snapshots permit
 * only read routes after sealing and cannot be queried while incomplete.
 */

import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";
import { decideSchemaHints } from "./lib/schema-hints";
import { BulkStore } from "./lib/bulk-store";
import type { BulkManifest, BulkPublication } from "./lib/bulk-types";

export class DepMapDataDO extends RestStagingDO {
    private bulk() {
        return new BulkStore({ exec: (query, ...values) => this.sql.exec(query, ...values) }, run => this.ctx.storage.transactionSync(run));
    }

    async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        const bulk = this.bulk();
        if (path.startsWith("/bulk/")) {
            try {
                if (path === "/bulk/current" && request.method === "GET") return Response.json({ success: true, current: bulk.current() });
                if (path === "/bulk/status" && request.method === "GET") return Response.json({ success: true, ...bulk.status() });
                if (request.method !== "POST") throw new Error("Unsupported bulk request");
                const body = await request.json() as Record<string, unknown>;
                let result: unknown;
                if (path === "/bulk/begin") result = bulk.begin(body.manifest as BulkManifest, String(body.data_access_id), body.expected_current as string | null);
                else if (path === "/bulk/append") result = bulk.append(body.file_index as number, body.chunk_index as number, body.data_base64 as string);
                else if (path === "/bulk/verify") result = bulk.verify(body.file_index as number);
                else if (path === "/bulk/seal") result = bulk.seal();
                else if (path === "/bulk/publish") result = bulk.publish(body.publication as BulkPublication, body.expected_current as string | null);
                else if (path === "/bulk/abort") result = bulk.abort();
                else throw new Error("Unknown bulk operation");
                return Response.json({ success: true, data: result });
            } catch (error) {
                return Response.json({ success: false, error: String((error as Error).message) }, { status: 400 });
            }
        }
        const state = bulk.state();
        if (state) {
            if (state.phase !== "sealed") return Response.json({ success: false, error: "Incomplete or aborted bulk snapshot is not queryable" }, { status: 409 });
            if (!["/query", "/query-enhanced", "/schema"].includes(path)) return Response.json({ success: false, error: "Verified bulk snapshots are immutable" }, { status: 409 });
        }
        return super.fetch(request);
    }

    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        return decideSchemaHints(data);
    }
}
