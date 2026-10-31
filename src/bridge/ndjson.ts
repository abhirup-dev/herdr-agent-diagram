// NDJSON framing: one JSON value per line. JSON.stringify never emits a raw newline, so a line is a frame.

export const encode = (value: unknown) => `${JSON.stringify(value)}\n`;

/** Largest line kept (a full scene is ~1 MB); a longer one is dropped whole, not split into garbage frames. */
export const MAX_LINE = 32 << 20;

/** Splits a byte or text stream into lines, across chunk boundaries (and UTF-8 sequences split between chunks). */
export class LineDecoder {
  #text = new TextDecoder();
  #buf = "";
  #skipping = false;

  push(chunk: Uint8Array | string): string[] {
    this.#buf += typeof chunk === "string" ? chunk : this.#text.decode(chunk, { stream: true });
    const lines = this.#buf.split("\n");
    this.#buf = lines.pop() ?? "";
    if (this.#skipping && lines.length) {
      lines.shift(); // the tail of an oversized line
      this.#skipping = false;
    }
    if (this.#buf.length > MAX_LINE) {
      this.#buf = "";
      this.#skipping = true;
    }
    return lines.filter((l) => l.length > 0 && l.length <= MAX_LINE);
  }
}

/** Lines of a byte stream (a child's stdout, process.stdin). */
export async function* readLines(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const dec = new LineDecoder();
  for await (const chunk of stream) yield* dec.push(chunk);
}
