import { describe, expect, it } from "vitest";
import { engineeringLimitsProfile } from "./engineering-profile";
import { validateEngineeringLimitsProfile } from "@openvibecoaster/core";
import raw from "../../../../data/profiles/engineering-limits-v1.json";

describe("engineering profile authoring source", () => {
  it("JSON file parses and validates as full profile", () => {
    expect(() => validateEngineeringLimitsProfile(raw)).not.toThrow();
    expect(engineeringLimitsProfile.profileId).toBe(
      "project-engineering-limits-v1",
    );
    expect(engineeringLimitsProfile.provenance).toBe(
      "PROJECT_ENGINEERING_LIMIT",
    );
    expect(engineeringLimitsProfile.verticalG.minimum).toBe(-1.2);
    expect(engineeringLimitsProfile.verticalG.maximum).toBe(5.0);
    expect(engineeringLimitsProfile.maximumAbsoluteLateralG).toBe(1.5);
    expect(engineeringLimitsProfile.clearanceMarginM).toBe(0.5);
    expect(engineeringLimitsProfile.seams.positionM).toBe(0.0001);
  });

  it("drift: imported profile equals raw JSON (no transform)", () => {
    expect(engineeringLimitsProfile).toEqual(raw);
  });
});
