/**
 * Unified CSV → array-of-objects parser shared by MCP servers that ingest
 * bulk CSV (cms-pricing fee schedules, oig-leie exclusions, depmap matrices).
 *
 * Replaces two near-duplicate per-server parsers and fixes one latent bug
 * (oig's split-by-line approach mishandled newlines inside quoted strings).
 */
const DEFAULT_NUMERIC_SAMPLE_SIZE = 100;
const NUMERIC_CLASSIFICATION_THRESHOLD = 0.75;
/**
 * Tokenize CSV text into a 2-D array of trimmed string fields. The parser
 * is a single-pass character state machine, so quoted fields with embedded
 * commas, newlines, and escaped double-quotes are all handled correctly.
 *
 * Rows whose every field is the empty string are dropped, matching both
 * legacy parsers' behavior.
 */
function tokenize(text) {
    const rows = [];
    let current = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < text.length && text[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                field += ch;
            }
        }
        else if (ch === '"') {
            inQuotes = true;
        }
        else if (ch === ",") {
            current.push(field.trim());
            field = "";
        }
        else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
            current.push(field.trim());
            field = "";
            if (current.some((f) => f !== ""))
                rows.push(current);
            current = [];
            if (ch === "\r")
                i++;
        }
        else {
            field += ch;
        }
    }
    if (field || current.length > 0) {
        current.push(field.trim());
        if (current.some((f) => f !== ""))
            rows.push(current);
    }
    return rows;
}
/**
 * Decide whether a string looks like a JS-castable number. Rejects
 * codes/identifiers that begin with a leading zero (e.g. "02139") so
 * ZIP-like and NPI-like columns retain their string identity.
 */
function isNumericString(s) {
    if (s === "")
        return false;
    if (s.length > 1 && s[0] === "0" && s[1] !== ".")
        return false;
    return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s);
}
/**
 * Classify each column as numeric (true) or non-numeric (false) based on a
 * sample of the data rows. A column is numeric only when strictly more than
 * 75% of non-empty sampled values pass {@link isNumericString}.
 */
function detectNumericColumns(headers, dataRows, sampleSize) {
    const numericColumns = new Set();
    const sampleCount = Math.min(sampleSize, dataRows.length);
    for (let col = 0; col < headers.length; col++) {
        let numericCount = 0;
        let nonEmptyCount = 0;
        for (let row = 0; row < sampleCount; row++) {
            const val = dataRows[row]?.[col]?.trim() ?? "";
            if (val === "")
                continue;
            nonEmptyCount++;
            if (isNumericString(val))
                numericCount++;
        }
        if (nonEmptyCount > 0 &&
            numericCount / nonEmptyCount > NUMERIC_CLASSIFICATION_THRESHOLD) {
            numericColumns.add(col);
        }
    }
    return numericColumns;
}
/**
 * Parse CSV text into an array of plain objects keyed by header name.
 * Auto-casts numeric columns by default — see {@link ParseCsvOptions}.
 */
export function parseCsv(text, options = {}) {
    const { autoCastNumbers = true, stripHeaderQuotes = false, numericDetectionSampleSize = DEFAULT_NUMERIC_SAMPLE_SIZE, } = options;
    const rows = tokenize(text);
    if (rows.length < 2)
        return [];
    const rawHeaders = rows[0];
    const headers = stripHeaderQuotes
        ? rawHeaders.map((h) => h.replace(/^"|"$/g, "").trim())
        : rawHeaders;
    const dataRows = rows.slice(1);
    const numericColumns = autoCastNumbers
        ? detectNumericColumns(headers, dataRows, numericDetectionSampleSize)
        : new Set();
    return dataRows.map((row) => {
        const obj = {};
        for (let i = 0; i < headers.length; i++) {
            const raw = row[i] ?? "";
            if (numericColumns.has(i) && raw !== "") {
                const num = Number(raw);
                obj[headers[i]] = Number.isFinite(num) ? num : raw;
            }
            else {
                obj[headers[i]] = raw;
            }
        }
        return obj;
    });
}
/**
 * Strict-string variant — every cell value is the raw string from the CSV,
 * with no numeric coercion. Equivalent to
 * `parseCsv(text, { autoCastNumbers: false, stripHeaderQuotes: true })`
 * narrowed to a string-typed return value, for call sites that depend on
 * `Record<string, string>` typing (e.g. oig-leie's exclusion records).
 */
export function parseCsvAsStrings(text) {
    const rows = parseCsv(text, {
        autoCastNumbers: false,
        stripHeaderQuotes: true,
    });
    return rows;
}
//# sourceMappingURL=csv-parser.js.map