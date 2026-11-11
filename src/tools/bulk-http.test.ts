/// <reference types="node" />
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { verifyCitationEnvelope } from "@bio-mcp/shared";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { fixture, recover } from "./bulk.test-support";
import worker, { MyMCP } from "../index";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const hash = (algorithm: string, bytes: string | Uint8Array) => createHash(algorithm).update(bytes).digest("hex");
const requestId = (n: number) => "11111111-1111-4111-8111-" + String(n).padStart(12, "0");
function sample() {
  const f = fixture();
  const raw = Buffer.from('\ufeffModelID,gene,gene,\r\nACH-1,0,NA,\r\nACH-1,-1e-8,"λ\nline","quote""text"');
  const versions = ["releaseA", "releaseB", "releaseC"];
  const csv = "release,release_date,filename,md5_hash\n" + versions.map(release => release + ",2026-01-01,matrix.csv," + hash("md5", raw)).join("\n") + "\n";
  const fetcher = vi.fn(async () => new Response(csv, { headers: { "content-type": "text/csv" } }));
  vi.stubGlobal("fetch", fetcher);
  let calls = 0; let maxBytes = 0;
  const rpc = async (name: string, args: unknown, token: string | null = "fixture-admin") => {
    const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-method": "tools/call", "mcp-name": name, "mcp-protocol-version": "2026-07-28" };
    if (token !== null) headers.authorization = "Bearer " + token;
    const request = new Request("http://fixture/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "depmap-fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
    const response = await MyMCP.serve("/mcp").fetch(request, f.env as never, { waitUntil() {} } as never);
    const wire = await response.text(); expect(response.status, wire).toBe(200);
    calls++; maxBytes = Math.max(maxBytes, Buffer.byteLength(wire));
    expect(Buffer.byteLength(wire)).toBeLessThan(30720);
    const result = JSON.parse(wire).result;
    expect(result).toMatchObject({ content: expect.any(Array), structuredContent: expect.any(Object) });
    if (result.structuredContent._meta?.citation && !result.structuredContent._staging) {
      const checked = await verifyCitationEnvelope({ citation: result.structuredContent._meta.citation, structuredContent: result.structuredContent, toolArguments: args });
      expect(checked.verification).toMatchObject({ query: "verified", result: "verified", quarantined: false });
    }
    return result;
  };
  const selection = (version = "releaseA") => ({ cohort: "adult", version, expected_metadata_sha256: hash("sha256", csv), files: [{ release: version, filename: "matrix.csv", md5: hash("md5", raw), bytes: raw.length, role: "crispr", index_column: 1, index_type: "ModelID" }] });
  const operation = async (args: Record<string, unknown>, prefix = "") => {
    const result = await rpc(prefix + "depmap_load_release", args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent.data;
  };
  const begin = (n: number, version = "releaseA", prefix = "") => operation({ action: "begin", request_id: requestId(n), selection: selection(version) }, prefix);
  const upload = async (id: string, prefix = "") => {
    for (let start = 0, i = 0; start < raw.length; start += 11, i++) await operation({ action: "append", data_access_id: id, file_index: 0, chunk_index: i, data_base64: raw.subarray(start, start + 11).toString("base64") }, prefix);
    await operation({ action: "verify", data_access_id: id, file_index: 0 }, prefix);
  };
  return { ...f, rpc, raw, fetcher, selection, operation, begin, upload, metrics: () => ({ calls, maxBytes }) };
}
it("honors the real request admin header before inventory or storage work", async () => {
  const f = sample();
  try {
    for (const prefix of ["", "mcp_"]) for (const token of [null, "wrong"]) {
      const result = await f.rpc(prefix + "depmap_load_release", { action: "begin", request_id: requestId(1), selection: f.selection() }, token);
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("AUTH_ERROR");
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally { f.close(); }
});
it("verifies and atomically publishes literal records with both aliases, stable retries and current pointers", async () => {
  const f = sample();
  try {
    for (const [n, prefix] of ["", "mcp_"].entries()) {
      const started = await f.begin(n + 1, n ? "releaseB" : "releaseA", prefix);
      expect(started.phase).toBe("uploading");
      expect((await f.begin(n + 1, n ? "releaseB" : "releaseA", prefix)).data_access_id).toBe(started.data_access_id);
      const premature = await f.rpc(prefix + "depmap_query_data", { data_access_id: started.data_access_id, sql: "SELECT * FROM depmap_rows" });
      expect(premature.isError).toBe(true);
      await f.upload(started.data_access_id, prefix);
      const before = await f.rpc(prefix + "depmap_release_status", { cohort: "adult" }, null);
      expect(before.structuredContent.data.cohorts.adult.currentVersion).toBe(n ? "releaseA" : null);
      const published = await f.operation({ action: "publish", data_access_id: started.data_access_id }, prefix);
      expect(published.current).toMatchObject({ data_access_id: started.data_access_id, version: n ? "releaseB" : "releaseA", datasets: 1, totalRows: 2 });
      expect((await f.operation({ action: "publish", data_access_id: started.data_access_id }, prefix)).reused).toBe(true);
      const query = await f.rpc(prefix + "depmap_query_data", { data_access_id: "adult:current", sql: "SELECT cells_json FROM depmap_rows ORDER BY record_index" });
      expect(query.isError, JSON.stringify(query)).not.toBe(true);
      expect(query.structuredContent.data.rows.map((row: { cells_json: string }) => JSON.parse(row.cells_json))).toEqual([["ACH-1", "0", "NA", ""], ["ACH-1", "-1e-8", "λ\nline", 'quote"text']]);
      const schema = await f.rpc(prefix + "depmap_get_schema", { data_access_id: "adult:current" });
      expect(schema.isError).not.toBe(true); expect(JSON.stringify(schema)).toContain("depmap_rows");
      const chunks = await f.rpc(prefix + "depmap_query_data", { data_access_id: started.data_access_id, sql: "SELECT data_base64 FROM depmap_chunks ORDER BY chunk_index" });
      expect(Buffer.concat(chunks.structuredContent.data.rows.map((row: { data_base64: string }) => Buffer.from(row.data_base64, "base64")))).toEqual(f.raw);
      const repeated = await f.begin(n + 10, n ? "releaseB" : "releaseA", prefix);
      expect(repeated).toMatchObject({ reused: true, phase: "published", current: { data_access_id: started.data_access_id } });
    }
    expect(f.metrics().calls).toBeGreaterThan(30);
  } finally { f.close(); }
}, 30000);
it("keeps the prior current snapshot after corruption and concurrent publication", async () => {
  const f = sample();
  try {
    const initial = await f.begin(1); await f.upload(initial.data_access_id);
    await f.operation({ action: "publish", data_access_id: initial.data_access_id });
    const bad = await f.begin(2, "releaseB");
    await f.operation({ action: "append", data_access_id: bad.data_access_id, file_index: 0, chunk_index: 0, data_base64: Buffer.alloc(f.raw.length, 120).toString("base64") });
    expect((await f.rpc("depmap_load_release", { action: "verify", data_access_id: bad.data_access_id, file_index: 0 })).isError).toBe(true);
    expect((await f.rpc("depmap_load_release", { action: "publish", data_access_id: bad.data_access_id })).isError).toBe(true);
    const one = await f.begin(3, "releaseB");
    const two = await f.begin(4, "releaseC");
    await f.upload(one.data_access_id); await f.upload(two.data_access_id);
    await f.operation({ action: "publish", data_access_id: one.data_access_id });
    const conflict = await f.rpc("depmap_load_release", { action: "publish", data_access_id: two.data_access_id });
    expect(conflict.isError).toBe(true); expect(JSON.stringify(conflict)).toContain("Current release changed");
    const status = await f.rpc("depmap_release_status", {}, null);
    expect(status.structuredContent.data.cohorts).toMatchObject({ adult: { currentVersion: "releaseB", stats: { datasets: 1, totalRows: 2 } }, pediatric: { currentVersion: null, stats: null } });
    const retry = await f.operation({ action: "publish", data_access_id: two.data_access_id, expected_current: one.data_access_id });
    expect(retry.current.data_access_id).toBe(two.data_access_id);
  } finally { f.close(); }
}, 30000);
it("keeps large SQL results intact through complete-envelope staging", async () => {
  const f = sample();
  try {
    const started = await f.begin(1); await f.upload(started.data_access_id); await f.operation({ action: "publish", data_access_id: started.data_access_id });
    for (const prefix of ["", "mcp_"]) {
      const result = await f.rpc(prefix + "depmap_query_data", { data_access_id: "adult:current", sql: "SELECT replace(hex(zeroblob(40000)), '00', 'x') AS value" });
      expect(result.structuredContent._staging).toBeDefined();
      expect((await recover(f, result.structuredContent.data_access_id, prefix)).structuredContent.data.rows[0].value).toBe("x".repeat(40000));
    }
  } finally { f.close(); }
}, 30000);
it("rejects changed inventory/file pins and challenges without creating an import", async () => {
  const f = sample();
  try {
    for (const selection of [{ ...f.selection(), expected_metadata_sha256: "0".repeat(64) }, { ...f.selection(), files: [{ ...f.selection().files[0], md5: "0".repeat(32) }] }]) {
      const output = await f.rpc("depmap_load_release", { action: "begin", request_id: requestId(1), selection });
      expect(output.isError).toBe(true);
    }
    f.fetcher.mockImplementation(async () => new Response("<html>verification</html>", { headers: { "content-type": "text/html" } }));
    const result = await f.rpc("depmap_load_release", { action: "begin", request_id: requestId(1), selection: f.selection() });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("did not return CSV");
  } finally { f.close(); }
});
it("cron observes inventory without implicitly importing or publishing guessed releases", async () => {
  const f = sample(); const tasks: Promise<unknown>[] = [];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    worker.scheduled({} as ScheduledEvent, f.env as never, { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as never);
    await Promise.all(tasks);
    expect(log).toHaveBeenCalledWith("depmap.inventory", expect.objectContaining({ imported: false, files: 3 }));
    expect((await f.rpc("depmap_release_status", {})).structuredContent.data.cohorts.adult.currentVersion).toBeNull();
  } finally { f.close(); }
});
it("publishes all selected files together and retains both matrix orientations and independent PRISM rows", async () => {
  const f = sample();
  const sources = [
    { filename: "Model.csv", release: "fixture", role: "model", index_type: "ModelID", raw: "ModelID,lineage\nACH-1,Lung\nACH-2,Skin\n" },
    { filename: "effect.csv", release: "fixture", role: "crispr", index_type: "ModelID", raw: "ModelID,TP53 (7157),TP53 (7157)\nACH-1,-0.00,NA\nACH-9,1e-08,\n" },
    { filename: "expression.csv", release: "fixture", role: "omics", index_type: "gene", raw: ",ACH-1,ACH-2\nTP53 (7157),01.00,0\n" },
    { filename: "PRISM.csv", release: "separate PRISM", role: "prism", index_type: "ModelID", raw: "ModelID,drug,value\nACH-1,BRD-1,-0.25\nACH-1,BRD-2,NA\nACH-9,BRD-3,\n" },
  ];
  const inventory = "release,release_date,filename,md5_hash\n" + sources.map(file => [file.release, "fixture-date", file.filename, hash("md5", file.raw)].join(",")).join("\n");
  f.fetcher.mockImplementation(async () => new Response(inventory, { headers: { "content-type": "text/csv" } }));
  try {
    const selection = { cohort: "pediatric", version: "fixture", expected_metadata_sha256: hash("sha256", inventory), files: sources.map(({ raw, ...file }) => ({ ...file, md5: hash("md5", raw), bytes: Buffer.byteLength(raw), index_column: 1 })) };
    const started = await f.operation({ action: "begin", request_id: requestId(100), selection });
    for (const [file_index, source] of sources.entries()) {
      await f.operation({ action: "append", data_access_id: started.data_access_id, file_index, chunk_index: 0, data_base64: Buffer.from(source.raw).toString("base64") });
      if (file_index < sources.length - 1) {
        await f.operation({ action: "verify", data_access_id: started.data_access_id, file_index });
        const early = await f.rpc("mcp_depmap_load_release", { action: "publish", data_access_id: started.data_access_id });
        expect(early.isError).toBe(true);
        expect((await f.rpc("depmap_query_data", { data_access_id: "pediatric:current", sql: "SELECT 1" })).isError).toBe(true);
      }
    }
    await f.operation({ action: "verify", data_access_id: started.data_access_id, file_index: 3 });
    const published = await f.operation({ action: "publish", data_access_id: started.data_access_id }, "mcp_");
    expect(published.current).toMatchObject({ cohort: "pediatric", datasets: 4, totalRows: 8, file_sha256: sources.map(source => hash("sha256", source.raw)) });
    for (const prefix of ["", "mcp_"]) {
      const query = async (sql: string) => (await f.rpc(prefix + "depmap_query_data", { data_access_id: "pediatric:current", sql })).structuredContent.data.rows;
      expect(await query("SELECT a.record_index AS source_row,b.record_index AS model_row FROM depmap_rows a LEFT JOIN depmap_rows b ON b.file_index=0 AND b.index_value=a.index_value WHERE a.file_index=3 ORDER BY a.record_index")).toEqual([
        { source_row: 1, model_row: 1 }, { source_row: 2, model_row: 1 }, { source_row: 3, model_row: null },
      ]);
      expect((await query("SELECT cells_json FROM depmap_rows WHERE file_index=2"))[0].cells_json).toBe('["TP53 (7157)","01.00","0"]');
      expect((await query("SELECT columns_json FROM depmap_files WHERE file_index=1"))[0].columns_json).toBe('["ModelID","TP53 (7157)","TP53 (7157)"]');
      const chunks = await query("SELECT file_index,data_base64 FROM depmap_chunks ORDER BY file_index,chunk_index");
      expect(chunks.map((row: { data_base64: string }) => Buffer.from(row.data_base64, "base64").toString())).toEqual(sources.map(source => source.raw));
    }
    const status = await f.rpc("depmap_release_status", { cohort: "pediatric" });
    expect(Object.keys(status.structuredContent.data.cohorts)).toEqual(["pediatric"]);
    expect((await f.rpc("depmap_query_data", { data_access_id: "adult:current", sql: "SELECT 1" })).isError).toBe(true);
    const mutation = await f.rpc("depmap_query_data", { data_access_id: started.data_access_id, sql: "DELETE FROM depmap_rows" });
    expect(mutation.isError).toBe(true);
  } finally { f.close(); }
}, 30000);
