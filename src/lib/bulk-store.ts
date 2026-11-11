import { createHash } from "node:crypto";
import { csvRecords } from "./bulk-csv";
import type { BulkManifest, BulkPublication, BulkSql } from "./bulk-types";

const CHUNK_BYTES = 48 * 1024;
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
type State = { phase: "uploading" | "sealed" | "aborted"; manifest: BulkManifest; data_access_id: string; expected_current: string | null };
export class BulkStore {
  constructor(private sql: BulkSql, private transaction: <T>(run: () => T) => T) {
    sql.exec("CREATE TABLE IF NOT EXISTS _depmap_import (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  private get<T>(key: string): T | null {
    const row = this.sql.exec("SELECT value FROM _depmap_import WHERE key=?", key).toArray()[0];
    return row ? JSON.parse(String(row.value)) as T : null;
  }
  private put(key: string, value: unknown) {
    this.sql.exec("INSERT INTO _depmap_import VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
  }
  current() { return this.get<BulkPublication>("current"); }
  state() { return this.get<State>("state"); }
  private loading() {
    const state = this.state();
    if (!state || state.phase !== "uploading") throw new Error("Snapshot is not open for upload");
    return state;
  }
  begin(manifest: BulkManifest, id: string, expectedCurrent: string | null) {
    if (this.state()) throw new Error("Snapshot already initialized");
    this.transaction(() => {
      this.sql.exec("CREATE TABLE depmap_files (file_index INTEGER PRIMARY KEY, release TEXT NOT NULL, filename TEXT NOT NULL, role TEXT NOT NULL, declared_bytes INTEGER NOT NULL, md5 TEXT NOT NULL, bytes_received INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, rows INTEGER NOT NULL DEFAULT 0, columns_json TEXT, sha256 TEXT, source_json TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE depmap_chunks (file_index INTEGER NOT NULL, chunk_index INTEGER NOT NULL, byte_offset INTEGER NOT NULL, data_base64 TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(file_index,chunk_index))");
      this.sql.exec("CREATE TABLE depmap_rows (file_index INTEGER NOT NULL, record_index INTEGER NOT NULL, index_value TEXT, cells_json TEXT NOT NULL, PRIMARY KEY(file_index,record_index))");
      this.sql.exec("CREATE INDEX depmap_identifier ON depmap_rows(file_index,index_value,record_index)");
      manifest.selection.files.forEach((file, index) => {
        this.sql.exec("INSERT INTO depmap_files(file_index,release,filename,role,declared_bytes,md5,source_json) VALUES (?,?,?,?,?,?,?)", index, file.release, file.filename, file.role, file.bytes, file.md5.toLowerCase(), JSON.stringify({ selection: file, inventory: manifest.metadata.selected[index] }));
      });
      this.put("state", { phase: "uploading", manifest, data_access_id: id, expected_current: expectedCurrent } satisfies State);
    });
    return this.status();
  }
  append(fileIndex: number, chunkIndex: number, encoded: string) {
    this.loading();
    if (!Number.isSafeInteger(fileIndex) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new Error("Invalid file/chunk index");
    if (typeof encoded !== "string" || encoded.length > CHUNK_BYTES * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("Chunk must be canonical base64 of at most 48 KiB");
    const raw = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    if (!raw.length || btoa(String.fromCharCode(...raw)) !== encoded) throw new Error("Chunk is empty or noncanonical");
    return this.transaction(() => {
      const file = this.sql.exec("SELECT * FROM depmap_files WHERE file_index=?", fileIndex).toArray()[0];
      if (!file || file.verified) throw new Error("File is missing or already verified");
      const hash = digest(raw);
      const prior = this.sql.exec("SELECT sha256,data_base64 FROM depmap_chunks WHERE file_index=? AND chunk_index=?", fileIndex, chunkIndex).toArray()[0];
      if (prior) {
        if (prior.sha256 !== hash || prior.data_base64 !== encoded) throw new Error("Retry differs from the accepted chunk");
        return { accepted: true, duplicate: true, next_chunk: file.chunks, bytes_received: file.bytes_received };
      }
      if (chunkIndex !== file.chunks) throw new Error("Upload chunks in order; resume from next_chunk");
      const bytes = Number(file.bytes_received) + raw.byteLength;
      if (bytes > Number(file.declared_bytes)) throw new Error("Upload exceeds the declared file size");
      this.sql.exec("INSERT INTO depmap_chunks VALUES (?,?,?,?,?)", fileIndex, chunkIndex, Number(file.bytes_received), encoded, hash);
      this.sql.exec("UPDATE depmap_files SET bytes_received=?,chunks=chunks+1 WHERE file_index=?", bytes, fileIndex);
      return { accepted: true, duplicate: false, next_chunk: chunkIndex + 1, bytes_received: bytes };
    });
  }
  verify(fileIndex: number) {
    const state = this.loading();
    const selection = state.manifest.selection.files[fileIndex];
    const file = this.sql.exec("SELECT * FROM depmap_files WHERE file_index=?", fileIndex).toArray()[0];
    if (!selection || !file) throw new Error("Unknown file index");
    if (file.verified) return { verified: true, rows: file.rows, sha256: file.sha256 };
    if (file.bytes_received !== file.declared_bytes) throw new Error("File upload is incomplete");
    return this.transaction(() => {
      const md5 = createHash("md5");
      const sha256 = createHash("sha256");
      const sql = this.sql;
      let headers: string[] | undefined; let rows = 0;
      for (const values of csvRecords(verifiedChunks(sql, fileIndex, Number(file.declared_bytes), md5, sha256))) {
        if (!headers) {
          headers = values;
          if (new TextEncoder().encode(JSON.stringify(headers)).byteLength > 1024 * 1024) throw new Error("Encoded CSV header exceeds the SQLite row budget");
          if ((selection.index_column ?? 1) > headers.length) throw new Error("Selected index column is outside the CSV layout");
          continue;
        }
        if (values.length !== headers.length) throw new Error("CSV row width differs at record " + (rows + 1));
        if (++rows > 10_000_000) throw new Error("File exceeds ten million records");
        const index = selection.index_column ? values[selection.index_column - 1] : null;
        const encoded = JSON.stringify(values);
        if (new TextEncoder().encode(encoded).byteLength > 1024 * 1024) throw new Error("Encoded CSV row exceeds the SQLite row budget");
        this.sql.exec("INSERT INTO depmap_rows VALUES (?,?,?,?)", fileIndex, rows, index, encoded);
      }
      if (!headers) throw new Error("Empty file cannot establish a CSV header");
      if (md5.digest("hex") !== selection.md5.toLowerCase()) throw new Error("Complete file MD5 differs from the provider pin");
      const hash = sha256.digest("hex");
      this.sql.exec("UPDATE depmap_files SET verified=1,rows=?,columns_json=?,sha256=? WHERE file_index=?", rows, JSON.stringify(headers), hash, fileIndex);
      return { verified: true, rows, sha256: hash };
    });
  }
  seal() {
    if (this.state()?.phase === "sealed") return this.status();
    const state = this.loading();
    const files = this.sql.exec("SELECT verified,rows FROM depmap_files ORDER BY file_index").toArray();
    if (files.length !== state.manifest.selection.files.length || files.some(file => file.verified !== 1)) throw new Error("Every selected file must pass verification before sealing");
    this.put("state", { ...state, phase: "sealed" });
    return this.status();
  }
  status() {
    const state = this.state();
    if (!state) return { state: null };
    return { ...state, files: this.sql.exec("SELECT file_index,filename,bytes_received,chunks,verified,rows,sha256 FROM depmap_files ORDER BY file_index").toArray() };
  }
  publish(publication: BulkPublication, expectedCurrent: string | null) {
    return this.transaction(() => {
      const current = this.current();
      if (current?.manifest_sha256 === publication.manifest_sha256) {
        if (JSON.stringify(current.file_sha256) !== JSON.stringify(publication.file_sha256)) throw new Error("Verified bytes differ for the same provider manifest");
        return { current, reused: true };
      }
      if ((current?.data_access_id ?? null) !== expectedCurrent) throw new Error("Current release changed while uploading; inspect it before publishing");
      this.put("current", publication);
      return { current: publication, reused: false };
    });
  }
  abort() {
    const state = this.loading();
    this.put("state", { ...state, phase: "aborted" });
    return { aborted: true };
  }
}

function* verifiedChunks(sql: BulkSql, fileIndex: number, declaredBytes: number, md5: ReturnType<typeof createHash>, sha256: ReturnType<typeof createHash>) {
        let expected = 0; let offset = 0;
        for (const chunk of sql.exec("SELECT * FROM depmap_chunks WHERE file_index=? ORDER BY chunk_index", fileIndex)) {
          if (chunk.chunk_index !== expected++ || chunk.byte_offset !== offset) throw new Error("Stored chunks are not contiguous");
          const raw = Uint8Array.from(atob(String(chunk.data_base64)), char => char.charCodeAt(0));
          if (digest(raw) !== chunk.sha256) throw new Error("Stored chunk hash mismatch");
          offset += raw.length; md5.update(raw); sha256.update(raw); yield raw;
        }
        if (offset !== declaredBytes) throw new Error("Stored bytes differ from the manifest");
      }
