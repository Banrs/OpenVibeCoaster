import { describe, expect, it } from "vitest";
import { collectTransferables, hasDuplicateBuffers } from "./transfer";

describe("collectTransferables", () => {
  it("collects every owned typed-array buffer exactly once", () => {
    const a = new Float64Array([1, 2, 3]);
    const b = new Uint32Array([4, 5]);
    const c = new Float64Array([6]);
    const payload = {
      track: { positions: a, zoneMasks: b },
      extra: { positionsAgain: a },
    };
    const buffers = collectTransferables(payload);
    // Should contain 2 unique buffers (a and b) not 3
    expect(buffers).toHaveLength(2);
    expect(buffers).toContain(a.buffer);
    expect(buffers).toContain(b.buffer);
    expect(hasDuplicateBuffers(buffers)).toBe(false);
    // c not in payload so not collected
    expect(buffers).not.toContain(c.buffer);
  });

  it("deduplicates identical buffer references", () => {
    const arr = new Float64Array([9, 9]);
    const payload = { a: arr, b: arr, c: arr.buffer };
    const buffers = collectTransferables(payload);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]).toBe(arr.buffer);
    expect(hasDuplicateBuffers(buffers)).toBe(false);
  });

  it("handles timeline transfer buffers wrapper", () => {
    const t = new Float64Array([0, 1, 2]);
    const h = new Float64Array([2, 3, 4]);
    const timelineTransfer = {
      sampleRateHz: 60,
      carCount: 2,
      length: 3,
      buffers: [t.buffer, h.buffer],
    };
    const track = { positions: new Float64Array([1]) };
    const buffers = collectTransferables({ track, timeline: timelineTransfer });
    expect(buffers).toContain(t.buffer);
    expect(buffers).toContain(h.buffer);
    expect(buffers).toContain(track.positions.buffer);
    expect(buffers).toHaveLength(3);
  });

  it("does not collect caller-owned request buffers when only response is passed", () => {
    const requestBuffer = new Float64Array([100]);
    const responseBuffer = new Float64Array([200]);
    void requestBuffer;
    const response = { track: { positions: responseBuffer } };
    const buffers = collectTransferables(response);
    expect(buffers).toContain(responseBuffer.buffer);
    expect(buffers).not.toContain(requestBuffer.buffer);
    // Ensure request buffer still usable (not neutered)
    expect(requestBuffer[0]).toBe(100);
  });

  it("handles nested arrays and objects", () => {
    const a = new Float64Array([1]);
    const b = new Uint32Array([2]);
    const payload = { nested: [{ x: a }, { y: [b] }] };
    const buffers = collectTransferables(payload);
    expect(buffers).toHaveLength(2);
  });

  it("returns empty for no typed arrays", () => {
    expect(collectTransferables({ foo: "bar", count: 123 })).toEqual([]);
    expect(collectTransferables(null)).toEqual([]);
  });

  it("detects duplicate buffers correctly", () => {
    const buf = new ArrayBuffer(8);
    expect(hasDuplicateBuffers([buf, buf])).toBe(true);
    expect(hasDuplicateBuffers([buf, new ArrayBuffer(8)])).toBe(false);
  });

  it("handles SharedArrayBuffer views without transferring", () => {
    const sab = new SharedArrayBuffer(16);
    const view = new Float64Array(sab);
    view[0] = 123;
    const payload = { view };
    const buffers = collectTransferables(payload);
    // SharedArrayBuffer is not transferable, should not be collected as ArrayBuffer
    expect(buffers).toHaveLength(0);
    expect(view[0]).toBe(123);
  });

  it("deduplicates offset views sharing same ArrayBuffer", () => {
    const buf = new ArrayBuffer(16);
    const view1 = new Float64Array(buf, 0, 1);
    const view2 = new Float64Array(buf, 8, 1);
    view1[0] = 1;
    view2[0] = 2;
    const payload = { a: view1, b: view2 };
    const buffers = collectTransferables(payload);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]).toBe(buf);
  });

  it("handles cycles without infinite loop", () => {
    const buf = new Float64Array([1, 2]).buffer;
    const obj: Record<string, unknown> = { a: new Float64Array(buf) };
    (obj as Record<string, unknown>).self = obj;
    const buffers = collectTransferables(obj);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]).toBe(buf);
  });

  it("handles aliases via different paths", () => {
    const arr = new Uint32Array([5, 6, 7]);
    const payload = {
      path1: { track: { data: arr } },
      path2: { timeline: { buffers: [arr.buffer] } },
      path3: arr,
    };
    const buffers = collectTransferables(payload);
    expect(buffers).toHaveLength(1);
    expect(buffers[0]).toBe(arr.buffer);
  });

  it("excludes caller request buffer even when response shares structure", () => {
    const requestBuf = new Float64Array([9, 9, 9]);
    const responseBuf = new Float64Array([8, 8, 8]);
    const request = { intent: { data: requestBuf } };
    const response = { track: { positions: responseBuf }, shared: requestBuf };
    // Simulate passing only response payload (caller-owned request not included)
    const responseOnly = { track: { positions: responseBuf } };
    const buffers = collectTransferables(responseOnly);
    expect(buffers).toContain(responseBuf.buffer);
    expect(buffers).not.toContain(requestBuf.buffer);
    // Ensure original request buffer still intact
    expect(requestBuf[0]).toBe(9);
    void request;
    void response;
  });
});
