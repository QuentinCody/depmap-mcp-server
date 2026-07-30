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

// Admin-gated load-release tool wraps loadRelease and enforces auth.
{
    const f = "src/tools/load-release.ts";
    const c = readFile(f);
    assertContains(f, c, "DEPMAP_ADMIN_TOKEN", `${f}: references admin token slot`);
    assertContains(f, c, "AUTH_ERROR", `${f}: returns AUTH_ERROR on bad bearer`);
    assertContains(f, c, "CONFIG_ERROR", `${f}: returns CONFIG_ERROR when token unset`);
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

// Singleton DO routing wired in index.ts.
{
    const f = "src/index.ts";
    const c = readFile(f);
    assertContains(f, c, '"release:adult:current"', `${f}: well-known adult DO id`);
    assertContains(f, c, '"release:pediatric:current"', `${f}: well-known pediatric DO id`);
    assertContains(f, c, "scheduled(", `${f}: exports scheduled cron handler`);
    assertContains(f, c, "checkAndIngestLatest", `${f}: cron delegates to scheduled lib`);
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
