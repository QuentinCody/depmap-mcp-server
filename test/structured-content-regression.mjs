#!/usr/bin/env node

/**
 * Regression tests for the DepMap MCP server's source structure and
 * Code Mode response shapes.
 *
 * This script is grep-style — it doesn't run the MCP server. It just
 * proves that each tool file imports the right shared helpers and
 * registers under both the `mcp_<name>` and bare `<name>` aliases.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assertContains(filePath, haystack, needle, testName) {
    totalTests++;
    if (haystack.includes(needle)) {
        console.log(`${GREEN}✓${RESET} ${testName}`);
        passedTests++;
    } else {
        console.log(`${RED}✗${RESET} ${testName}`);
        console.log(`  Missing: ${needle}`);
        console.log(`  File: ${filePath}`);
        failedTests++;
    }
}

function assertNotContains(filePath, haystack, needle, testName) {
    totalTests++;
    if (!haystack.includes(needle)) {
        console.log(`${GREEN}✓${RESET} ${testName}`);
        passedTests++;
    } else {
        console.log(`${RED}✗${RESET} ${testName}`);
        console.log(`  Unexpected: ${needle}`);
        console.log(`  File: ${filePath}`);
        failedTests++;
    }
}

function readFile(relPath) {
    const absPath = path.resolve(SERVER_ROOT, relPath);
    return fs.readFileSync(absPath, "utf8");
}

console.log(`${BLUE}DepMap Structured Content Regression Tests${RESET}`);

// Tools that must wire through @bio-mcp/shared staging utils, with
// each tool's expected mcp_-prefixed alias.
const stagingToolFiles = [
    { path: "src/tools/query-data.ts", alias: "mcp_depmap_query_data" },
    { path: "src/tools/get-schema.ts", alias: "mcp_depmap_get_schema" },
];
for (const t of stagingToolFiles) {
    const c = readFile(t.path);
    assertContains(t.path, c, "@bio-mcp/shared/staging/utils", `${t.path}: imports staging utils`);
    assertContains(t.path, c, "DEPMAP_DATA_DO", `${t.path}: references DEPMAP_DATA_DO binding`);
    assertContains(t.path, c, t.alias, `${t.path}: registers mcp_-prefixed alias (${t.alias})`);
}

// Code Mode tool registers depmap_search + depmap_execute via shared factories.
{
    const f = "src/tools/code-mode.ts";
    const c = readFile(f);
    assertContains(f, c, "@bio-mcp/shared/codemode/search-tool", `${f}: imports createSearchTool`);
    assertContains(f, c, "@bio-mcp/shared/codemode/execute-tool", `${f}: imports createExecuteTool`);
    assertContains(f, c, "depmapCatalog", `${f}: passes depmapCatalog to factories`);
    assertContains(f, c, "createDepMapApiFetch", `${f}: passes the depmap api adapter`);
}

// The active importer requires the request Bearer header before discovery/storage.
{
    const f = "src/lib/bulk-runtime.ts";
    const c = readFile(f);
    assertContains(f, c, "DEPMAP_ADMIN_TOKEN", `${f}: references admin token slot`);
    assertContains(f, c, "AUTH_ERROR", `${f}: returns AUTH_ERROR on bad bearer`);
    assertContains(f, c, "!env.DEPMAP_ADMIN_TOKEN", `${f}: rejects an unset token`);
    assertContains(f, c, "createBulkManifest(args.selection)", `${f}: binds explicitly selected inventory entries`);
    assertContains(f, c, '"/bulk/seal"', `${f}: verifies all files before publishing`);
    const tool = readFile("src/tools/bulk.ts");
    assertContains(f, tool, '["depmap_load_release", "mcp_depmap_load_release"]', "bulk import: dual aliases");
    assertContains(f, tool, '["depmap_release_status", "mcp_depmap_release_status"]', "bulk status: dual aliases");
}

// Catalog: every endpoint declared, no auth (public REST), long-form notes.
{
    const f = "src/spec/catalog.ts";
    const c = readFile(f);
    assertContains(f, c, "https://depmap.org/portal/api", `${f}: declares depmap REST baseUrl`);
    assertContains(f, c, '"none"', `${f}: marks auth as none`);
    assertContains(f, c, "long-form", `${f}: notes mention long-form staging shape`);
    assertContains(f, c, "Figshare", `${f}: notes mention Figshare bulk path`);
    assertContains(f, c, "/gene_dependency/by_gene", `${f}: covers gene dependency endpoint`);
}

// The entrypoint wires resumable imports; cron only observes public inventory.
{
    const f = "src/index.ts";
    const c = readFile(f);
    assertContains(f, c, "registerBulkTools(this.server", `${f}: wires verified imports`);
    assertContains(f, c, 'requestInfo?.headers.get("authorization")', `${f}: uses the request admin header`);
    assertContains(f, c, "scheduled(", `${f}: exports scheduled cron handler`);
    assertContains(f, c, "imported: false", `${f}: cron observes without publishing`);
    assertNotContains(f, c, "checkAndIngestLatest", `${f}: no guessed-file scheduled ingestion`);
    assertContains(f, c, "DepMapDataDO", `${f}: exports DO class for wrangler binding`);
}

// wrangler.jsonc has the cron trigger + both DO bindings.
{
    const f = "wrangler.jsonc";
    const c = readFile(f);
    assertContains(f, c, '"DEPMAP_DATA_DO"', `${f}: declares DEPMAP_DATA_DO binding`);
    assertNotContains(f, c, '"MCP_OBJECT"', `${f}: has no retired transport DO binding`);
    assertContains(f, c, '"mcp-2026-07-28-stateless"', `${f}: deletes the retired transport class`);
    assertContains(f, c, '"crons"', `${f}: declares cron trigger`);
    assertContains(f, c, "0 11 * * *", `${f}: cron runs daily at 11:00 UTC`);
    assertContains(f, c, '"port": 8816', `${f}: dev port matches manifest`);
}

console.log("");
console.log(`${BLUE}Results:${RESET} ${passedTests}/${totalTests} passed`);
if (failedTests > 0) {
    console.log(`${RED}${failedTests} tests failed${RESET}`);
    process.exit(1);
}
console.log(`${GREEN}All tests passed${RESET}`);
