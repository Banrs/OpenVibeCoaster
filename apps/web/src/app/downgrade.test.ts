import { describe, it, expect } from "vitest";
import { downgradeIfNoTrack } from "./downgrade.js";

describe("downgradeIfNoTrack", () => {
  it("downgrades ready/generating without track to error", () => {
    expect(downgradeIfNoTrack("ready", false)).toBe("error");
    expect(downgradeIfNoTrack("generating", false)).toBe("error");
  });
  it("keeps pending/error without track truthful", () => {
    expect(downgradeIfNoTrack("pending", false)).toBe("pending");
    expect(downgradeIfNoTrack("error", false)).toBe("error");
  });
  it("keeps all statuses with track truthful", () => {
    expect(downgradeIfNoTrack("ready", true)).toBe("ready");
    expect(downgradeIfNoTrack("generating", true)).toBe("generating");
    expect(downgradeIfNoTrack("pending", true)).toBe("pending");
    expect(downgradeIfNoTrack("error", true)).toBe("error");
  });
});
