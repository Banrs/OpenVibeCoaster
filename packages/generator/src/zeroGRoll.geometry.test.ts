import { expect, test } from "vitest";
import { vec3Dot, vec3Normalize } from "@openvibecoaster/core";
import { buildElement, createElement, defaultPose } from "./elements.js";

test("zero-G roll contains its ballistic descent and restores its entry tangent", () => {
  const entry = defaultPose();
  const result = buildElement(
    createElement("zeroGRoll", "roll", {
      length: 280,
      roll: Math.PI * 2,
    }),
    entry,
    34,
  );
  const span = result.solvedSpans[0]!;
  const startTangent = vec3Normalize(span.span.derivative(0, 1));
  const endTangent = vec3Normalize(span.span.derivative(1, 1));

  expect(vec3Dot(startTangent, entry.tangent)).toBeGreaterThan(1 - 1e-10);
  expect(vec3Dot(endTangent, entry.tangent)).toBeGreaterThan(1 - 1e-10);
  expect(vec3Dot(result.endPose.tangent, entry.tangent)).toBeGreaterThan(
    1 - 1e-10,
  );
});
