/** Strict streaming CSV records. Values and duplicate/empty header labels stay literal. */
export function* csvRecords(chunks: Iterable<Uint8Array>, maxRecordBytes = 1024 * 1024): Generator<string[]> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let closing = false;
  let skipLF = false;
  let touched = false;
  let recordBytes = 0;
  function* accept(text: string) {
    for (const char of text) {
      if (skipLF) { skipLF = false; if (char === "\n") continue; }
      const point = char.codePointAt(0)!;
      recordBytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (recordBytes > maxRecordBytes) throw new Error("CSV record exceeds the 1 MiB budget");
      if (quoted) {
        if (char === '"') { quoted = false; closing = true; }
        else cell += char;
        continue;
      }
      if (closing && char === '"') { cell += '"'; quoted = true; closing = false; continue; }
      if (char === ",") { cells.push(cell); cell = ""; closing = false; touched = true; continue; }
      if (char === "\n" || char === "\r") {
        cells.push(cell);
        yield cells;
        cells = []; cell = ""; closing = false; touched = false; recordBytes = 0;
        skipLF = char === "\r";
        continue;
      }
      if (closing || (char === '"' && cell !== "")) throw new Error("Malformed CSV quoting");
      if (char === '"') quoted = true;
      else cell += char;
      touched = true;
    }
  }
  for (const chunk of chunks) yield* accept(decoder.decode(chunk, { stream: true }));
  yield* accept(decoder.decode());
  if (quoted) throw new Error("Unterminated CSV field");
  if (touched || closing || cell !== "" || cells.length) { cells.push(cell); yield cells; }
}
