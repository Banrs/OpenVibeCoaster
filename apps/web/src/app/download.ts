import { serializeCoasterFileV1 } from "@openvibecoaster/core";
import type { CoasterFileV1 } from "@openvibecoaster/core";

export function downloadCoasterFile(
  file: CoasterFileV1,
  prefix: string,
): { url: string; timerId: number } {
  const text = serializeCoasterFileV1(file);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  const timerId = window.setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }, 1000);
  return { url, timerId };
}
