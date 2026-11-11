import type { ApiEndpoint } from "@bio-mcp/shared/codemode/catalog";

export const releaseEndpoints: ApiEndpoint[] = [{
  method: "GET", path: "/no-captcha/download/files", category: "release_discovery", featured: true,
  summary: "Discover public DepMap and collaborator release/file metadata, including PRISM, CRISPR and omics. Public metadata endpoint announced July 2026; download URLs omitted. Preserves all CSV columns and gives a metadata SHA-256 snapshot. MCP selectors filter locally, never infer latest or download access.",
  queryParams: [
    { name: "release", type: "string", required: false, description: "MCP-only exact release name from discovery; omit to enumerate all releases." },
    { name: "filename", type: "string", required: false, description: "MCP-only exact filename; requires release. Inspect the actual file schema before joining." },
    { name: "expected_metadata_sha256", type: "string", required: false, description: "MCP-only previous inventory SHA-256; rejects metadata drift. Does not verify file contents." },
  ],
  example: 'const inventory = await api.get("/no-captcha/download/files"); return inventory;',
}];
