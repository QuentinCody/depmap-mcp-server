/** Bound decoded upstream bytes. The fetch signal also bounds the body read. */
export async function readDepMapResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let result = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8_000_000) throw new Error("DepMap response exceeds 8MB");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
}
