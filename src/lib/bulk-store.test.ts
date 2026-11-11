/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { BulkStore } from "./bulk-store";
import { csvRecords } from "./bulk-csv";
import { validateSelection, type BulkManifest, type BulkSql } from "./bulk-types";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const md5 = (raw: Uint8Array) => createHash("md5").update(raw).digest("hex");
function setup(raw = new TextEncoder().encode('\ufeffModelID,cell,cell,\r\nACH-1,0,"NA",\r\nACH-1,-1e-8,"λ\nline","quote""text"')) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const sql: BulkSql = { exec(query, ...values) { const rows = db.prepare(query).all(...values); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
  const tx = <T>(run: () => T) => { db.exec("BEGIN"); try { const result = run(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const manifest: BulkManifest = { format_version: "depmap-bulk-1", manifest_sha256: "a".repeat(64),
    selection: { cohort: "adult", version: "releaseA", expected_metadata_sha256: "b".repeat(64), files: [{ release: "releaseA", filename: "matrix.csv", md5: md5(raw), bytes: raw.length, role: "crispr", index_column: 1, index_type: "ModelID" }] },
    metadata: { url: "https://depmap.org/portal/api/no-captcha/download/files", sha256: "b".repeat(64), retrieved_at: "fixture", inventory_file_count: 1, selected: [{ source_row_index: 0, record: { release: "releaseA", filename: "matrix.csv", md5_hash: md5(raw) } }] } };
  const store = new BulkStore(sql, tx);
  store.begin(manifest, "depmap_bulk_adult_fixture", null);
  const append = () => { let i = 0; for (let start = 0; start < raw.length; start += 7) store.append(0, i++, Buffer.from(raw.slice(start, start + 7)).toString("base64")); };
  return { db, store, manifest, raw, append, reopen: () => new BulkStore(sql, tx) };
}

it("preserves every literal CSV cell and original byte through arbitrary UTF-8/quote chunks and restart", () => {
  const f = setup(); f.append();
  const reopened = f.reopen();
  expect(reopened.verify(0)).toMatchObject({ verified: true, rows: 2 });
  expect(reopened.verify(0)).toMatchObject({ verified: true, rows: 2 });
  const values = f.db.prepare("SELECT cells_json,index_value FROM depmap_rows ORDER BY record_index").all();
  expect(values.map(row => JSON.parse(String(row.cells_json)))).toEqual([["ACH-1", "0", "NA", ""], ["ACH-1", "-1e-8", "λ\nline", 'quote"text']]);
  expect(values.map(row => row.index_value)).toEqual(["ACH-1", "ACH-1"]);
  expect(JSON.parse(String(f.db.prepare("SELECT columns_json FROM depmap_files").get()!.columns_json))).toEqual(["ModelID", "cell", "cell", ""]);
  const recovered = Buffer.concat(f.db.prepare("SELECT data_base64 FROM depmap_chunks ORDER BY chunk_index").all().map(row => Buffer.from(String(row.data_base64), "base64")));
  expect(recovered).toEqual(Buffer.from(f.raw));
  expect(reopened.seal()).toMatchObject({ phase: "sealed" });
  expect(reopened.seal()).toMatchObject({ phase: "sealed" });
  expect(() => reopened.append(0, 0, "YQ==")).toThrow("not open");
});
it("makes matching chunk retries idempotent and rejects changed/out-of-order/overlong chunks", () => {
  const f = setup(); const first = Buffer.from(f.raw.slice(0, 7)).toString("base64");
  expect(f.store.append(0, 0, first)).toMatchObject({ duplicate: false, next_chunk: 1 });
  expect(f.reopen().append(0, 0, first)).toMatchObject({ duplicate: true, next_chunk: 1, bytes_received: 7 });
  expect(() => f.store.append(0, 0, "YQ==")).toThrow("Retry differs");
  expect(() => f.store.append(0, 2, "YQ==")).toThrow("in order");
  expect(() => f.store.append(0, 1, Buffer.from("x".repeat(1000)).toString("base64"))).toThrow("exceeds");
  expect(() => f.store.verify(0)).toThrow("incomplete");
  expect(() => f.store.seal()).toThrow("Every selected");
});
it.each(["", "YQ", "YQ==\n", "YR==", "A".repeat(65540)])("rejects noncanonical/empty/oversized chunks %#", encoded => {
  const f = setup(); expect(() => f.store.append(0, 0, encoded)).toThrow();
  expect(f.db.prepare("SELECT count(*) AS n FROM depmap_chunks").get()!.n).toBe(0);
});
it("rolls all parsed rows back on a complete-file MD5 mismatch", () => {
  const f = setup(); f.append();
  f.db.prepare("UPDATE _depmap_import SET value=? WHERE key='state'").run(JSON.stringify({ ...f.store.state(), manifest: { ...f.manifest, selection: { ...f.manifest.selection, files: [{ ...f.manifest.selection.files[0], md5: "0".repeat(32) }] } } }));
  expect(() => f.store.verify(0)).toThrow("MD5");
  expect(f.db.prepare("SELECT count(*) AS n FROM depmap_rows").get()!.n).toBe(0);
  expect(f.db.prepare("SELECT verified FROM depmap_files").get()!.verified).toBe(0);
});
it.each([Buffer.from("a,b\nx,y\nz\n"), Buffer.from('a,b\nx,"unterminated'), Buffer.from([97,44,98,10,120,44,255,10])])("rejects malformed complete CSV/UTF-8 with no partial rows %#", raw => {
  const f = setup(raw); f.append(); expect(() => f.store.verify(0)).toThrow();
  expect(f.db.prepare("SELECT count(*) AS n FROM depmap_rows").get()!.n).toBe(0);
});
it("detects damaged stored chunks before declaring a file verified", () => {
  const f = setup(); f.append();
  f.db.prepare("UPDATE depmap_chunks SET data_base64='YQ==' WHERE chunk_index=0").run();
  expect(() => f.store.verify(0)).toThrow("chunk hash");
});
it("uses compare-and-swap publication and reuses an identical manifest", () => {
  const f = setup();
  const first = { data_access_id: "first", manifest_sha256: "a".repeat(64), cohort: "adult" as const, version: "releaseA", datasets: 1, totalRows: 2, file_sha256: ["d".repeat(64)], published_at: "fixture" };
  expect(f.store.publish(first, null)).toMatchObject({ reused: false, current: first });
  expect(f.store.publish({ ...first, data_access_id: "duplicate" }, null)).toMatchObject({ reused: true, current: first });
  expect(() => f.store.publish({ ...first, file_sha256: ["e".repeat(64)] }, null)).toThrow("Verified bytes differ");
  const second = { ...first, data_access_id: "second", manifest_sha256: "b".repeat(64) };
  expect(() => f.store.publish(second, null)).toThrow("changed");
  expect(f.reopen().current()).toEqual(first);
  expect(f.store.publish(second, "first")).toMatchObject({ current: second });
});
it("aborts only an unsealed upload", () => {
  const f = setup(); expect(f.store.abort()).toEqual({ aborted: true });
  expect(f.reopen().state()?.phase).toBe("aborted");
  expect(() => f.store.append(0, 0, "YQ==")).toThrow("not open");
  expect(() => f.store.seal()).toThrow("not open");
});
it("bounds individual CSV records without dropping blanks or final rows", () => {
  const chunks = [new TextEncoder().encode("a\n\nlast")];
  expect([...csvRecords(chunks)]).toEqual([["a"], [""], ["last"]]);
  expect(() => [...csvRecords([new TextEncoder().encode("λλλ")], 5)]).toThrow("record exceeds");
});
it("requires exact primary releases and explicit cross-release PRISM identity", () => {
  const f = setup(); expect(validateSelection(f.manifest.selection)).toEqual(f.manifest.selection);
  expect(() => validateSelection({ ...f.manifest.selection, version: "latest" })).toThrow("primary release");
  expect(() => validateSelection({ ...f.manifest.selection, files: [f.manifest.selection.files[0], f.manifest.selection.files[0]] })).toThrow("only once");
  expect(() => validateSelection({ ...f.manifest.selection, files: [{ ...f.manifest.selection.files[0], index_type: undefined }] })).toThrow("together");
});
it.each(["header", "row"])("checks JSON expansion of a CSV %s against the SQLite row budget", kind => {
  const expanded = "\u0001".repeat(180000);
  const raw = Buffer.from(kind === "header" ? expanded + "\nvalue\n" : "header\nvalid\n" + expanded + "\n");
  const f = setup(raw);
  for (let start = 0, index = 0; start < raw.length; start += 48 * 1024, index++) f.store.append(0, index, raw.subarray(start, start + 48 * 1024).toString("base64"));
  expect(() => f.store.verify(0)).toThrow("SQLite row budget");
  expect(f.db.prepare("SELECT count(*) AS n FROM depmap_rows").get()!.n).toBe(0);
  expect(f.store.status()).toMatchObject({ phase: "uploading", files: [{ verified: 0 }] });
});
