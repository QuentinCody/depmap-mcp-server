import { describe, expect, it, vi } from "vitest";
import { createDepMapApiFetch } from "./api-adapter";
import { discoverReleases, METADATA_PATH, METADATA_URL, parseInventoryCsv, sha256 } from "./release-discovery";
import { readDepMapResponse } from "./response";

const csv = 'release,release_date,filename,md5_hash,note\r\nDepMap Public fixture,2026-01-01,Model.csv,00000000000000000000000000000001,"new,\nquoted ""field"""\r\nPRISM fixture,2024-01-01,drug.csv,00000000000000000000000000000002,α\r\n';

it("discovers independent releases without dropping future columns or inferring latest", async () => {
  const result = await discoverReleases(csv);
  expect(result.releases).toEqual(["DepMap Public fixture", "PRISM fixture"]);
  expect(result.files[0]).toMatchObject({ md5_hash: "00000000000000000000000000000001", note: 'new,\nquoted "field"' });
  expect(result).toMatchObject({ metadata_sha256: await sha256(csv), complete: true, download_access: "not_established", file_checksums_verified: false });
  expect(result).not.toHaveProperty("latest");
  expect(result.files[0]).not.toHaveProperty("url");
});

it("pins the complete inventory hash while applying exact local release/file selectors", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8" } }));
  const api = createDepMapApiFetch({ fetch: fetcher });
  const result = await api({ method: "GET", path: METADATA_PATH, params: { release: "DepMap Public fixture", filename: "Model.csv", expected_metadata_sha256: await sha256(csv) } });
  expect(result.data).toMatchObject({ inventory_file_count: 2, files: [expect.objectContaining({ filename: "Model.csv" })] });
  expect(fetcher.mock.calls[0][0]).toBe(METADATA_URL);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal), headers: { accept: "text/csv" } });
  await expect(discoverReleases(csv + "\n", { expected_metadata_sha256: await sha256(csv) })).rejects.toThrow(/snapshot changed/);
});

describe("inventory errors", () => {
  it.each([
    ["unknown release", { release: "Latest" }],
    ["filename alone", { filename: "Model.csv" }],
    ["unknown selector", { offset: 1 }],
    ["non-string selector", { release: 1 }],
    ["empty selector", { release: "" }],
    ["bad hash", { expected_metadata_sha256: "bad" }],
  ])("rejects %s", async (_name, params) => { await expect(discoverReleases(csv, params)).rejects.toThrow(); });

  it.each([
    "release,filename,md5_hash\nr,f,\n",
    "release,release_date,filename,md5_hash,filename\nr,d,f,,f\n",
    "release,release_date,filename,md5_hash\nr,d,f,extra,column\n",
    'release,release_date,filename,md5_hash\nr,d,"f,\n',
    'release,release_date,filename,md5_hash\nr,d,"f"oops,\n',
    "release,release_date,filename,md5_hash\nr,d,f,not-a-hash\n",
  ])("rejects malformed or ambiguous CSV (%#)", text => { expect(() => parseInventoryCsv(text)).toThrow(); });

  it("accepts header-only inventories and preserves an absent checksum as unknown", async () => {
    expect((await discoverReleases("release,release_date,filename,md5_hash\n")).files).toEqual([]);
    expect(parseInventoryCsv("release,release_date,filename,md5_hash\nr,d,f,\n").files[0].md5_hash).toBe("");
  });

  it("fails on an HTML challenge without trying alternate download routes", async () => {
    const fetcher = vi.fn(async () => new Response("<html>challenge</html>", { headers: { "content-type": "text/html" } }));
    await expect(createDepMapApiFetch({ fetch: fetcher })({ method: "GET", path: METADATA_PATH })).rejects.toThrow(/did not return CSV/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds streamed UTF-8 bytes and cancels on overflow", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8_000_001)); }, cancel });
    await expect(readDepMapResponse(new Response(body))).rejects.toThrow(/8MB/);
    expect(cancel).toHaveBeenCalled();
    await expect(readDepMapResponse(new Response(new Uint8Array([0xff])))).rejects.toThrow();
  });
});
