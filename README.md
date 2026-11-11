# Depmap MCP Server

This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets MCP clients (Claude Desktop, Claude Code, Continue, etc.) query the upstream Depmap API in natural language. It is one of 100+ servers in the [Bio MCP](../../README.md) monorepo.

## Connect

The server is deployed and ready at:

```
https://depmap-mcp-server.quentincody.workers.dev/mcp
```

Add it to your MCP client (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "depmap": {
      "command": "npx",
      "args": ["mcp-remote", "https://depmap-mcp-server.quentincody.workers.dev/mcp"]
    }
  }
}
```

For local development the server runs at `http://localhost:8816/mcp` (start it with `./scripts/dev-servers.sh depmap`):

```json
{
  "mcpServers": {
    "depmap-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8816/mcp"]
    }
  }
}
```

## Tools

- `depmap_search` — discover API operations, including public release/file inventory
- `depmap_execute` — **Code Mode**: write JavaScript in a V8 isolate (`api.get()` / `api.post()` / `searchSpec()`) instead of issuing tool calls one by one
- `depmap_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `depmap_get_schema` — inspect the inferred schema of a staged dataset
- `depmap_release_status` — report verified published file selections and their exact file/row counts
- `depmap_load_release` — admin upload, verify and atomically publish explicitly selected complete CSV files
- `depmap_harmonize` — join supplied, explicitly pinned CRISPR, omics and PRISM subsets by model identity

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.
Both bare and `mcp_`-prefixed tool names are registered.

## Discover releases before selecting data

DepMap [announced a public metadata endpoint in July 2026](https://forum.depmap.org/t/provide-an-open-endpoint-for-latest-version-retrieval/4652).
It deliberately omits download URLs. In `depmap_execute`:

```js
return await api.get("/no-captcha/download/files");
```

Use the exact `release` and `filename` values from the returned inventory. A second call can filter locally and require the previous `expected_metadata_sha256`; a changed inventory fails instead of silently switching snapshots. If the inventory is staged, inspect the returned handle with `depmap_get_schema` and query it with `depmap_query_data`.

All inventory columns are retained as strings, including dates and MD5 values. The inventory hash identifies the fetched metadata snapshot; it does not verify file bytes. No release is labeled latest based on quarter naming. Collaborator releases, including PRISM, may have independent schedules. Metadata column names do not describe the schemas of the listed data files. Check each file's indexing, terms and citation on the [provider data page](https://depmap.org/portal/data_page/).

## Join supplied subsets

`depmap_harmonize` accepts parsed row subsets from files you have obtained separately. Every source requires its exact release name, filename and original file MD5. These are caller-declared pins; this tool does not download or verify the original files. Its SHA-256 fingerprints only the supplied JSON subset.

Supply `model` with `ModelID` rows from the selected model metadata file. Optionally supply `model_condition`, `screen_sequence_map`, and `omics_profiles`, using the actual columns in that release. All mapping files and CRISPR/omics datasets must use the same release. A PRISM dataset may pin an independent release when linking directly by `ModelID`; crosswalks cannot be borrowed from another release. Each `datasets` entry declares `kind` (`crispr`, `omics`, `prism`), `index_type` (`ModelID`, `ModelConditionID`, `ScreenID`, `SequencingID`), and `index_column` (the actual column in the supplied rows).

Synthetic input showing the shape (replace the release, files, checksums and rows with your selections):

```json
{
  "model": { "release": "fixture", "filename": "Model.csv", "md5_hash": "11111111111111111111111111111111", "rows": [{ "ModelID": "ACH-1", "OncotreeLineage": "Lung" }] },
  "datasets": [{ "release": "fixture", "filename": "CRISPRGeneEffect.csv", "md5_hash": "22222222222222222222222222222222", "kind": "crispr", "index_type": "ModelID", "index_column": "ModelID", "rows": [{ "ModelID": "ACH-1", "TP53 (7157)": -0.5 }] }]
}
```

The result retains all source records and adds `links` with zero-based dataset/row/model/mapping indices. Missing mappings remain visible with unmatched statuses; conflicting mappings fail. Repeated screen-to-sequencing mappings retain every row reference. Model conditions and omics default flags remain intact. No default flag is applied implicitly, and measurements are never averaged or multiplied through a many-to-many join. Model links alone do not establish shared assay conditions, equivalent drug/gene identifiers or comparability of effect scores. `complete` describes model linking within the supplied subset only. Limits: 5000 total source rows, 12 datasets, 1MB UTF-8 input; larger responses stage canonically.

## Import complete selected files

The admin importer binds selected files to an exact public inventory hash and each provider MD5. Obtain the CSV files separately through the provider's supported access path, inspect their actual headers, and record their byte sizes. The [local uploader](scripts/README.md) checks every local MD5/SHA-256 before upload, transfers resumable 48 KiB chunks, verifies complete bytes in the Durable Object, and publishes only after every selected file succeeds. A saved request UUID and matching-chunk checks make lost replies resumable.

Each selection has a separate immutable snapshot. The previous current selection remains available during upload or failed verification. Publication compares the current pointer with the one seen at begin; concurrent changes require an explicitly inspected `expected_current` before retry. Identical manifests and verified file hashes reuse the existing publication. Status counts mean selected CSV records, excluding headers; they do not mean measurements, available provider files or whole-release coverage.

`adult:current` and `pediatric:current` resolve only verified published snapshots. Query an explicit snapshot handle when reproducibility across future publications matters. Imported tables are:

| Table | Retained data |
| --- | --- |
| `depmap_files` | Zero-based file index, exact release/name/role, ordered `columns_json`, byte counts, MD5/SHA-256 and selected inventory record in `source_json` |
| `depmap_rows` | File index, one-based data-record index, optional literal `index_value`, ordered string array `cells_json` |
| `depmap_chunks` | File/chunk indices, byte offsets, original base64 bytes and chunk SHA-256 |

Both matrix orientations retain their native rows. Duplicate/empty headers, repeated records, empty cells, numeric spellings, quoted newlines and original BOM/line endings survive. No gene resolution, pivot, numeric coercion, averaging or default flag is applied. An optional one-based `index_column` indexes the literal cell for SQL joins; its declared `index_type` does not establish biological equivalence. Mapping/CRISPR/omics files share the exact primary release; separately released PRISM can link directly by ModelID. Check assay, condition, dose and identifier meanings before interpreting a join. Use `depmap_harmonize` for explicit model associations over bounded supplied subsets.

## Legacy lookup compatibility

The older lookup catalog derives from a [2019Q2 specification](https://github.com/broadinstitute/depmap-api/blob/master/depmap.yml) naming a different host. Existing portal routing is retained for compatibility, but current availability and release freshness are unverified.

The old hard-coded Figshare loader is no longer wired to the Worker entrypoint. `depmap_load_release` now requires an explicit `action` and pinned selection; old automatic-load arguments must be migrated. Cron observes public inventory only. Existing legacy tables remain readable with explicit `release:adult:current` / `release:pediatric:current` handles; they are not promoted to verified current snapshots. Inspect their actual schema and release suffixes before joining. Ordinary staging handles retain their routing.

Native current-file schema/byte acceptance, provider download authentication and full-size Workerd qualification remain pending. The local import path does not solve download authentication or bypass a verification challenge. Synthetic acceptance is separate from native qualification. ORCS remains outside this workflow.

## Development

```bash
./scripts/dev-servers.sh depmap            # run locally (port 8816)
pnpm --filter depmap-mcp-server run deploy   # deploy to Cloudflare Workers
```

See [`docs/adding-mcp-servers.md`](../../docs/adding-mcp-servers.md) and the root [README](../../README.md) for the full architecture (Code Mode, staging, portals).

---

Provider metadata guidance was reviewed on 2026-10-05. Live acceptance remains separate from fixture-based validation.

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from DepMap portal and stays under the terms of that source: DepMap portal terms (quoted by DepMap staff, 2026-07-28): commercial use of the data is not permitted. Releases up to 24Q4 are CC BY 4.0 on figshare but contain Sanger data; Sanger DepMap data: no commercial use without consent; legacy CCLE terms unclear.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
