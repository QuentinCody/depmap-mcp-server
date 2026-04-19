/**
 * Streaming CSV → row iterator for bulk-ingest servers whose source files
 * exceed Worker memory (DepMap matrices are ~60 MB; 128 MB Worker heap
 * cannot afford to buffer the whole file as text).
 *
 * Usage:
 *
 *   for await (const row of csvStream(response.body!)) {
 *     // row: Record<string, unknown> — same shape as parseCsv() result
 *   }
 *
 * The state machine is the same one used by {@link parseCsv} so quoted
 * fields with embedded commas, newlines, and escaped double-quotes are
 * handled correctly across chunk boundaries — including UTF-8 multi-byte
 * characters split between chunks (TextDecoder is used in streaming mode).
 *
 * Numeric column classification works on a buffered prefix of
 * {@link CsvStreamOptions.numericDetectionSampleSize} rows (default 100).
 * Once classification is decided, the buffered rows are emitted in order,
 * then the remainder of the stream is processed lazily.
 */
import type { ParseCsvOptions } from "./csv-parser";
export interface CsvStreamOptions extends Pick<ParseCsvOptions, "stripHeaderQuotes"> {
    /**
     * If true (default), columns are auto-cast to numbers based on a sample
     * of the first {@link numericDetectionSampleSize} rows. The sample is
     * collected by buffering rows internally before any are yielded.
     */
    readonly autoCastNumbers?: boolean;
    /**
     * Number of leading rows held back for numeric column classification
     * before any rows are emitted. Default 100. Smaller values reduce
     * memory at the cost of classification accuracy on heterogeneous
     * leading rows. Set to 0 to skip detection entirely.
     */
    readonly numericDetectionSampleSize?: number;
}
/**
 * Yields one row per gene/record in a streamed CSV. The first
 * {@link CsvStreamOptions.numericDetectionSampleSize} rows are buffered
 * for numeric column classification, then emitted in order alongside the
 * remainder of the stream.
 */
export declare function csvStream(stream: ReadableStream<Uint8Array>, options?: CsvStreamOptions): AsyncGenerator<Record<string, unknown>, void, unknown>;
//# sourceMappingURL=csv-stream.d.ts.map