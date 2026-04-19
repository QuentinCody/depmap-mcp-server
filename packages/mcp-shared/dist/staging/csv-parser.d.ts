/**
 * Unified CSV → array-of-objects parser shared by MCP servers that ingest
 * bulk CSV (cms-pricing fee schedules, oig-leie exclusions, depmap matrices).
 *
 * Replaces two near-duplicate per-server parsers and fixes one latent bug
 * (oig's split-by-line approach mishandled newlines inside quoted strings).
 */
export interface ParseCsvOptions {
    /**
     * If true (default), columns whose >75% of non-empty sampled values are
     * numeric are auto-cast to JS numbers. Leading-zero codes (e.g. ZIP
     * "02139") are excluded from numeric classification so they stay strings.
     */
    readonly autoCastNumbers?: boolean;
    /**
     * If true, headers wrapped in literal double quotes are stripped via
     * regex post-parse. Use only when the upstream CSV emits quoted headers
     * that must remain quoted in the source bytes (e.g. OIG's UPDATED.csv).
     * Default false — the field state machine already handles quoted
     * headers natively for well-formed input.
     */
    readonly stripHeaderQuotes?: boolean;
    /**
     * Number of data rows sampled for numeric column detection. Defaults to
     * min(100, totalRows). Larger values trade speed for classification
     * accuracy on heterogeneous columns.
     */
    readonly numericDetectionSampleSize?: number;
}
/**
 * Parse CSV text into an array of plain objects keyed by header name.
 * Auto-casts numeric columns by default — see {@link ParseCsvOptions}.
 */
export declare function parseCsv(text: string, options?: ParseCsvOptions): Record<string, unknown>[];
/**
 * Strict-string variant — every cell value is the raw string from the CSV,
 * with no numeric coercion. Equivalent to
 * `parseCsv(text, { autoCastNumbers: false, stripHeaderQuotes: true })`
 * narrowed to a string-typed return value, for call sites that depend on
 * `Record<string, string>` typing (e.g. oig-leie's exclusion records).
 */
export declare function parseCsvAsStrings(text: string): Record<string, string>[];
//# sourceMappingURL=csv-parser.d.ts.map