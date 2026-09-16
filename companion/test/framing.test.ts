import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameParser, encodeFrame } from "../src/native/framing.js";

test("parses multiple frames split across arbitrary chunk boundaries", () => {
  const a = { type: "ident", extensionId: "abc" };
  const b = { type: "request", url: "https://x/y", body: "中文內容 🙂" };
  const stream = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
  for (const chunk of [1, 3, 7, 13, 64]) {
    const parser = new FrameParser();
    const out: unknown[] = [];
    for (let i = 0; i < stream.length; i += chunk) out.push(...parser.push(stream.subarray(i, i + chunk)));
    assert.deepEqual(out, [a, b], `chunk size ${chunk}`);
  }
});

test("returns nothing until a frame is complete", () => {
  const parser = new FrameParser();
  const frame = encodeFrame({ type: "x" });
  assert.deepEqual(parser.push(frame.subarray(0, 4)), []);
  assert.deepEqual(parser.push(frame.subarray(4, frame.length - 1)), []);
  assert.deepEqual(parser.push(frame.subarray(frame.length - 1)), [{ type: "x" }]);
});
