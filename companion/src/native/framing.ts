/**
 * Chrome native messaging framing: each message is a 4-byte little-endian length followed by
 * UTF-8 JSON. Messages from Chrome are at most 1 MB; messages to Chrome at most 64 MB.
 */

export const MAX_INBOUND = 1024 * 1024;

export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns every complete message decoded from the stream so far. */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_INBOUND * 4) throw new Error(`Frame too large: ${len} bytes`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(body));
      } catch {
        out.push({ type: "_unparseable", raw: body.slice(0, 200) });
      }
    }
    return out;
  }
}

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}
