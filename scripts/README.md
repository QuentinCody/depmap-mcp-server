# Pinned DepMap CSV upload

`import_release.py` uses Python's standard library. It uploads files obtained separately through provider-supported access; it does not download files, obtain credentials or deploy infrastructure. The target Worker must already have the importer and its admin token configured.

Discover the public inventory with `depmap_execute`, retain its exact `metadata_sha256`, and select exact `release`, `filename` and `md5_hash` values. Inspect each downloaded CSV and compute its byte size. The example is synthetic; replace every pin and role with the actual selection:

```json
{
  "cohort": "adult",
  "version": "fixture release",
  "expected_metadata_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "files": [
    {
      "release": "fixture release",
      "filename": "Model.csv",
      "md5": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "bytes": 12345,
      "role": "model",
      "index_column": 1,
      "index_type": "ModelID"
    }
  ]
}
```

File order is significant. Roles are `model`, `model_condition`, `screen_sequence_map`, `omics_profiles`, `crispr`, `omics`, `prism` or `other`. An optional one-based `index_column` and `index_type` must appear together. Index types are `ModelID`, `ModelConditionID`, `ScreenID`, `SequencingID`, `gene` and `other`. They declare a literal SQL index, not validated biological identity. Mapping/CRISPR/omics files use the exact primary release; independent PRISM requires a direct ModelID index.

With the existing admin credential supplied through `DEPMAP_ADMIN_TOKEN`:

```bash
python3 servers/depmap-mcp-server/scripts/import_release.py selection.json Model.csv \
  --url https://YOUR-EXISTING-WORKER/mcp --state ./depmap-upload.json
```

Supply one local CSV path per selection entry, in order. All local files are hashed before network mutation. The state file is created exclusively before begin, retains the request UUID and file fingerprints, and never stores the admin token. Repeat the identical command after interruption: existing server progress is inspected, matching verified files are skipped, and incomplete files resume from their accepted offsets. The state file, endpoint, selection and local file hashes must still agree. If verification fails, inspect the source or abort the unsealed snapshot; a new attempt uses a new state path. Aborted bytes are retained, not deleted automatically.

Begin re-fetches inventory and rejects drift. Resume of an existing snapshot uses its retained manifest, so a later provider inventory change does not silently select different files. Publication switches only one cohort's pointer after all selected files verify. A concurrent publication leaves the prior current pointer intact and the new sealed snapshot available by its explicit handle. Inspect `depmap_release_status`, then optionally retry with `--expected-current EXACT_INSPECTED_DATA_ACCESS_ID`. This is a comparison against that exact pointer, not unconditional replacement.

The importer requires UTF-8 CSV with one header record and consistent row width. It retains all cells as strings, including duplicate/empty header names, and the complete original byte stream. It rejects malformed CSV/UTF-8, truncated files, incorrect checksums and oversize records. Bounds: 12 files, 2 GiB per file, 4 GiB total source bytes, 10 million data records per file, 1 MiB parsed/encoded record budget and 48 KiB upload chunks. These are admission limits, **not demonstrated full-size Worker capacity**: verification uses one synchronous SQLite transaction per file, and native CPU/storage/throughput limits remain unqualified. Actual storage exceeds source size because both raw bytes and parsed cells are retained.

Use a stable explicit snapshot handle for reproducible queries. To inspect layouts:

```sql
SELECT file_index, release, filename, columns_json, rows, sha256
FROM depmap_files ORDER BY file_index
```

To inspect literal data without coercing it:

```sql
SELECT record_index, index_value, cells_json
FROM depmap_rows WHERE file_index=0 ORDER BY record_index LIMIT 20
```

`depmap_chunks` reconstructs original bytes by concatenating base64-decoded `data_base64` in `chunk_index` order for one `file_index`. Query small substrings when recovering large chunks; tool responses over 30 KiB stage as complete envelopes. Python's client recovers staged metadata through bounded SQL reads. HTTPS is required except for explicit localhost development URLs; redirects are refused to keep the admin header at the selected endpoint.

Run uploader checks with:

```bash
python3 -m unittest discover -s servers/depmap-mcp-server/scripts -p 'test_*.py' -v
```
