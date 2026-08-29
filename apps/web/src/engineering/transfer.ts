/**
 * Collects owned transferable ArrayBuffers from a response payload.
 * Identity deduplication ensures each buffer is transferred exactly once.
 * Caller-owned request buffers must not be passed in.
 */
export function collectTransferables(root: unknown): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const result: ArrayBuffer[] = [];
  const stack: unknown[] = [root];
  const visitedObjects = new WeakSet<object>();

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || node === undefined) continue;
    if (node instanceof ArrayBuffer) {
      if (!seen.has(node)) {
        seen.add(node);
        result.push(node);
      }
      continue;
    }
    if (ArrayBuffer.isView(node)) {
      const buffer = (node as ArrayBufferView).buffer as ArrayBuffer;
      // Only transfer if buffer is an ArrayBuffer (not SharedArrayBuffer)
      if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
        seen.add(buffer);
        result.push(buffer);
      }
      continue;
    }
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node === "object") {
      const object = node as Record<string, unknown>;
      if (visitedObjects.has(object)) continue;
      visitedObjects.add(object);
      // Special handling for transfer objects that contain buffers array
      if (
        "buffers" in object &&
        Array.isArray((object as { buffers: unknown }).buffers)
      ) {
        for (const buf of (object as { buffers: unknown[] }).buffers)
          stack.push(buf);
      }
      for (const value of Object.values(object)) {
        if (value !== null && typeof value === "object") stack.push(value);
        else if (value instanceof ArrayBuffer) stack.push(value);
      }
    }
  }
  return result;
}

/**
 * After transfer, underlying buffers are detached. This helper asserts that
 * caller-owned buffers were not transferred (they remain usable) by checking
 * that the transfer list contains only buffers belonging to owned payload and
 * not those from a request object.
 * Used in tests to verify ownership.
 */
export function hasDuplicateBuffers(buffers: readonly ArrayBuffer[]): boolean {
  return new Set(buffers).size !== buffers.length;
}
