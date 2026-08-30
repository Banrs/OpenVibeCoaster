import { describe, expect, it } from "vitest";
import { getTelemetryNextIndex } from "./telemetryKeyboard.js";

describe("telemetryKeyboard – pure next index via getCanvasKeyboardAction", () => {
  it("maps ArrowLeft/Down to previous with clamp", () => {
    expect(getTelemetryNextIndex(2, "ArrowLeft", 5)).toBe(1);
    expect(getTelemetryNextIndex(2, "ArrowDown", 5)).toBe(1);
    expect(getTelemetryNextIndex(0, "ArrowLeft", 5)).toBe(0);
  });

  it("maps ArrowRight/Up to next with clamp", () => {
    expect(getTelemetryNextIndex(2, "ArrowRight", 5)).toBe(3);
    expect(getTelemetryNextIndex(2, "ArrowUp", 5)).toBe(3);
    expect(getTelemetryNextIndex(4, "ArrowRight", 5)).toBe(4);
  });

  it("maps Home to first and End to last", () => {
    expect(getTelemetryNextIndex(2, "Home", 5)).toBe(0);
    expect(getTelemetryNextIndex(2, "End", 5)).toBe(4);
  });

  it("returns clamped current for unknown keys and non-finite inputs", () => {
    expect(getTelemetryNextIndex(2, "x", 5)).toBe(2);
    expect(getTelemetryNextIndex(Number.NaN, "ArrowRight", 5)).toBe(0);
    expect(getTelemetryNextIndex(2, "ArrowRight", 0)).toBe(0);
  });

  it("truncates fractional indexes", () => {
    expect(getTelemetryNextIndex(2.9, "ArrowRight", 5)).toBe(3);
    expect(getTelemetryNextIndex(2.1, "ArrowLeft", 5)).toBe(1);
  });
});
