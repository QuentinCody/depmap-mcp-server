/** Public inventory: metadata is accessible independently of file downloads. */
export const METADATA_PATH = "/no-captcha/download/files";
export const METADATA_URL = `https://depmap.org/portal/api${METADATA_PATH}`;

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/** Strict, lossless string cells; reject malformed or ambiguous provider CSV. */
export function parseInventoryCsv(text: string) {
  const { columns, rows } = parseInventoryRows(text);
  for (const required of ["release", "release_date", "filename", "md5_hash"]) {
    if (!columns.includes(required)) throw new Error(`Inventory missing column: ${required}`);
  }
  const files = rows.map((values, i) => {
    if (values.length !== columns.length) throw new Error(`Inventory row ${i + 2} has inconsistent column count`);
    const record = Object.fromEntries(columns.map((column, j) => [column, values[j]]));
    if (!record.release || !record.filename) throw new Error(`Inventory row ${i + 2} has no release or filename`);
    if (record.md5_hash && !/^[a-f\d]{32}$/i.test(record.md5_hash)) throw new Error(`Invalid file MD5 in inventory row ${i + 2}`);
    return record;
  });
  return { columns, files };
}

function parseInventoryRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const endCell = () => { row.push(cell); cell = ""; closed = false; };
  const endRow = () => { endCell(); if (row.some(value => value !== "")) rows.push(row); row = []; };
  const csv = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (csv[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === ",") endCell();
    else if (char === "\r" || char === "\n") { endRow(); if (char === "\r" && csv[i + 1] === "\n") i++; }
    else if (char === '"' && cell === "" && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error("Malformed inventory CSV quoting");
      cell += char;
    }
  }
  if (quoted) throw new Error("Unterminated inventory CSV field");
  if (cell !== "" || row.length || closed) endRow();
  const columns = rows.shift() ?? [];
  if (columns.some(c => !c) || new Set(columns).size !== columns.length) throw new Error("Inventory has empty or duplicate columns");
  return { columns, rows };
}

export function discoverySelectors(params: Record<string, unknown> = {}) {
  for (const key of Object.keys(params)) {
    if (!["release", "filename", "expected_metadata_sha256"].includes(key)) throw new Error(`Unknown inventory selector: ${key}`);
    if (typeof params[key] !== "string" || !(params[key] as string).length) throw new Error(`${key} must be a nonempty string`);
  }
  if (params.filename && !params.release) throw new Error("Select an exact release with filename");
  if (params.expected_metadata_sha256 && !/^[a-f\d]{64}$/i.test(String(params.expected_metadata_sha256))) throw new Error("expected_metadata_sha256 must be a SHA-256 digest");
  return params as { release?: string; filename?: string; expected_metadata_sha256?: string };
}

export async function discoverReleases(text: string, params: Record<string, unknown> = {}) {
  const selectors = discoverySelectors(params);
  const metadataSha256 = await sha256(text);
  if (selectors.expected_metadata_sha256 && selectors.expected_metadata_sha256.toLowerCase() !== metadataSha256) throw new Error("DepMap metadata snapshot changed; repeat discovery and explicitly select files again");
  const inventory = parseInventoryCsv(text);
  const files = inventory.files.filter(file => (!selectors.release || file.release === selectors.release) && (!selectors.filename || file.filename === selectors.filename));
  if (selectors.release && !files.length) throw new Error("Selected release/file is absent from the current metadata snapshot");
  return {
    source: METADATA_URL, fetched_at: new Date().toISOString(), metadata_sha256: metadataSha256,
    selectors, columns: inventory.columns, inventory_file_count: inventory.files.length,
    releases: [...new Set(files.map(file => file.release))], files,
    complete: true, completeness_scope: "all inventory rows matching exact selectors; not file contents",
    download_access: "not_established", file_checksums_verified: false,
    notes: "No latest-release inference. Metadata columns are not data-file schemas. Check each selected file's indexing, terms and citation in the portal. This endpoint does not authorize or perform downloads.",
  };
}
