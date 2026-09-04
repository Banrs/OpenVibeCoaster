import { expect, test } from "vitest";
import profile from "../../../data/profiles/record-targets-v1.json" with {
  type: "json",
};
import { validateRecordTargetsProfile } from "./record-targets.js";

test("accepts the exact project engineering record targets", () => {
  expect(profile.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
  expect(profile.totalLengthM).toEqual([5200, 5400]);
  expect(profile.maxHeightM).toEqual([225, 235]);
  expect(profile.maxSpeedKmh).toEqual([285, 295]);
  expect(profile.invertedTopHatM).toEqual([90, 92]);
  expect(profile.immelmannM).toEqual([80, 82]);
  expect(profile.verticalLoopM).toEqual([66, 68]);
  expect(profile.diveDrop).toEqual({
    heightM: 210,
    toleranceM: 3,
    angleDeg: 110,
    toleranceDeg: 1.5,
  });
  expect(profile.force).toEqual({
    verticalPeakG: [4.8, 5],
    verticalMinG: -1.1,
    lateralMaxG: 1.5,
    longitudinalMaxG: 1.5,
    jerkMps3: 15,
    rollRateRadPerSec: 1.5,
  });
  expect(profile.holdSeconds).toBe(3);
  expect(() => validateRecordTargetsProfile(profile)).not.toThrow();
});

test("the record profile contains no standards or compliance claim", () => {
  expect(JSON.stringify(profile)).not.toMatch(
    /ASTM|F2291|licensed|compliance|certification/i,
  );
});

test("rejects non-project provenance and every target range outside its exact window", () => {
  expect(() =>
    validateRecordTargetsProfile({ ...profile, provenance: "SOURCE_VERIFIED" }),
  ).toThrow(/PROJECT_ENGINEERING_LIMIT/);

  const invalidRanges = [
    { totalLengthM: [5199, 5400] },
    { totalLengthM: [5200, 5401] },
    { maxHeightM: [224, 235] },
    { maxHeightM: [225, 236] },
    { maxSpeedKmh: [284, 295] },
    { maxSpeedKmh: [285, 296] },
    { invertedTopHatM: [89, 92] },
    { invertedTopHatM: [90, 93] },
    { immelmannM: [79, 82] },
    { immelmannM: [80, 83] },
    { verticalLoopM: [65, 68] },
    { verticalLoopM: [66, 69] },
    { force: { ...profile.force, verticalPeakG: [4.7, 5] } },
    { force: { ...profile.force, verticalPeakG: [4.8, 5.1] } },
  ];

  for (const change of invalidRanges)
    expect(() => validateRecordTargetsProfile({ ...profile, ...change })).toThrow();
});

test("rejects exact target values when they are changed", () => {
  const invalidTargets = [
    { diveDrop: { ...profile.diveDrop, heightM: 209 } },
    { diveDrop: { ...profile.diveDrop, heightM: 211 } },
    { diveDrop: { ...profile.diveDrop, toleranceM: 2.9 } },
    { diveDrop: { ...profile.diveDrop, toleranceM: 3.1 } },
    { diveDrop: { ...profile.diveDrop, angleDeg: 109 } },
    { diveDrop: { ...profile.diveDrop, angleDeg: 111 } },
    { diveDrop: { ...profile.diveDrop, toleranceDeg: 1.4 } },
    { diveDrop: { ...profile.diveDrop, toleranceDeg: 1.6 } },
    { force: { ...profile.force, verticalMinG: -1 } },
    { force: { ...profile.force, verticalMinG: -1.2 } },
    { force: { ...profile.force, lateralMaxG: 1.4 } },
    { force: { ...profile.force, lateralMaxG: 1.6 } },
    { force: { ...profile.force, longitudinalMaxG: 1.4 } },
    { force: { ...profile.force, longitudinalMaxG: 1.6 } },
    { force: { ...profile.force, jerkMps3: 14 } },
    { force: { ...profile.force, jerkMps3: 16 } },
    { force: { ...profile.force, rollRateRadPerSec: 1.4 } },
    { force: { ...profile.force, rollRateRadPerSec: 1.6 } },
    { holdSeconds: 2 },
    { holdSeconds: 4 },
  ];

  for (const change of invalidTargets)
    expect(() => validateRecordTargetsProfile({ ...profile, ...change })).toThrow();
});
